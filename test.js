const express = require('express');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/callback';
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;

const app = express();

const hubspot = axios.create({
    baseURL: 'https://api.hubapi.com',
    headers: {
        Authorization: `Bearer ${HUBSPOT_TOKEN}`,
        'Content-Type': 'application/json',
    },
    timeout: 60000,
});

// --- Progress tracking helpers ---
// const PROGRESS_FILE = './progress.json';

// // Helper to save progress
// function saveProgress(pageNumber) {
//     fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ lastPage: pageNumber }), 'utf8');
// }

// // Helper to load progress
// function loadProgress() {
//     if (fs.existsSync(PROGRESS_FILE)) {
//         return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')).lastPage;
//     }
//     return null;
// }

// --- Helper functions ---

async function fetchAccessToken(code) {
    const res = await axios.post('https://app.teamleader.eu/oauth2/access_token', null, {
        params: {
            grant_type: 'authorization_code',
            code,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            redirect_uri: REDIRECT_URI
        }
    });
    return res.data.access_token;
}

async function fetchDeals(accessToken, pageNumber, size) {
    const dealsData = JSON.stringify({
        filter: {},
        page: { size, number: pageNumber },
        sort: [{ field: "created_at", order: "desc" }]
    });
    const res = await axios.post(
        'https://api.focus.teamleader.eu/deals.list',
        dealsData, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            }
        }
    );
    return res.data.data || [];
}

async function fetchPhases(accessToken, phaseIds) {
    if (!phaseIds.length) return [];
    const phasesData = JSON.stringify({
        filter: { ids: phaseIds },
        page: { size: phaseIds.length, number: 1 }
    });
    const res = await axios.post(
        'https://api.focus.teamleader.eu/dealPhases.list',
        phasesData, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            }
        }
    );
    return res.data.data || [];
}

async function fetchContact(accessToken, customerId) {
    if (!customerId) return null;
    try {
        const res = await axios.post(
            'https://api.focus.teamleader.eu/contacts.info',
            JSON.stringify({ id: customerId }), {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${accessToken}`
                }
            }
        );
        return res.data.data || null;
    } catch (e) {
        return { error: e.response?.data || e.message };
    }
}

async function fetchUser(accessToken, userId) {
    if (!userId) return null;
    try {
        const res = await axios.post(
            'https://api.focus.teamleader.eu/users.info',
            JSON.stringify({ id: userId, includes: "external_rate" }), {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${accessToken}`
                }
            }
        );
        return res.data.data || null;
    } catch (e) {
        return { error: e.response?.data || e.message };
    }
}

async function fetchCompany(accessToken, companyId) {
    if (!companyId) return null;
    try {
        const res = await axios.post(
            'https://api.focus.teamleader.eu/companies.info',
            JSON.stringify({ id: companyId }), {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${accessToken}`
                }
            }
        );
        return res.data.data || null;
    } catch (e) {
        return { error: e.response?.data || e.message };
    }
}

// --- Business logic helpers ---

function mapTeamleaderStatusToHubspotStage(status, phaseName) {
    const phase = phaseName?.toLowerCase() || '';
    if (phase.includes('nieuw')) return 'appointmentscheduled';
    if (phase.includes('offerte verzonden')) return 'contractsent';
    if (phase.includes('contact na offerte')) return 'presentationscheduled';
    if (phase.includes('on hold')) return 'decisionmakerboughtin';
    switch (status) {
        case 'won': return 'closedwon';
        case 'lost': return 'closedlost';
        case 'open':
        default: return 'appointmentscheduled';
    }
}

function determineDealType(deal) {
    const customerId = deal.lead?.customer?.id;
    if (!customerId) return 'newbusiness';
    const customerDeals = deal.customer_details?.deals || [];
    const existingDeals = customerDeals.filter(d => d.id !== deal.id);
    return existingDeals.length > 0 ? 'existingbusiness' : 'newbusiness';
}

function mapTeamleaderDealToHubspot(deal) {
    return {
        properties: {
            dealname: deal.title || 'Teamleader Deal',
            description: deal.summary || '',
            amount: deal.estimated_value?.amount ? String(deal.estimated_value.amount) : undefined,
            pipeline: 'default',
            dealstage: mapTeamleaderStatusToHubspotStage(deal.status, deal.current_phase_details?.name),
            deal_status: deal.status,
            dealtype: determineDealType(deal),
            deal_last_update: deal.updated_at,
            createdate: deal.created_at,
            closedate: deal.closed_at,
            teamleader_web_url: deal.web_url,
            teamleader_id: deal.id // <-- Add this line
        }
    };
}

// --- HubSpot sync logic ---

async function syncDealsToHubspot(deals) {
    const now = new Date();
    const fiveYearsAgo = new Date(now);
    fiveYearsAgo.setFullYear(now.getFullYear() - 5);
    const twoYearsAgo = new Date(now);
    twoYearsAgo.setFullYear(now.getFullYear() - 2);

    for (const deal of deals) {
        const updatedAt = deal.updated_at ? new Date(deal.updated_at) : null;
        if (!updatedAt || updatedAt < fiveYearsAgo) continue;

        let marketingStatus = updatedAt > twoYearsAgo;

        // Sync contact
        let hubspotContactId = null;
        const contact = deal.contact_details;
        let contactEmail = Array.isArray(contact?.emails) && contact.emails.length > 0
            ? contact.emails.find(c => c.type === 'primary')?.email || contact.emails[0].email
            : undefined;

        if (contactEmail) {
            try {
                const searchRes = await hubspot.post('/crm/v3/objects/contacts/search', {
                    filterGroups: [{
                        filters: [{
                            propertyName: 'email',
                            operator: 'EQ',
                            value: contactEmail
                        }]
                    }],
                    properties: ['email']
                });

                if (searchRes.data.results.length > 0) {
                    hubspotContactId = searchRes.data.results[0].id;
                    await hubspot.patch(`/crm/v3/objects/contacts/${hubspotContactId}`, {
                        properties: {
                            email: contactEmail,
                            firstname: contact.first_name || contact.firstname,
                            lastname: contact.last_name || contact.lastname,
                            phone: contact.telephone || contact.phone,
                            hs_marketable_status: marketingStatus || ''
                        }
                    });
                } else {
                    const contactRes = await hubspot.post('/crm/v3/objects/contacts', {
                        properties: {
                            email: contactEmail,
                            firstname: contact.first_name || contact.firstname,
                            lastname: contact.last_name || contact.lastname,
                            phone: contact.telephone || contact.phone,
                        }
                    });
                    hubspotContactId = contactRes.data.id;
                }
            } catch (error) {
                console.error('❌ Error syncing contact:', contactEmail, error.response?.data || error.message);
            }
        }

        // Sync deal
        const hubspotDeal = mapTeamleaderDealToHubspot(deal);
        let hubspotDealId = null;

        try {
            const dealSearchRes = await hubspot.post('/crm/v3/objects/deals/search', {
                filterGroups: [{
                    filters: [{ 
                        propertyName: 'teamleader_id',
                        operator: 'EQ',
                        value: deal.id
                    }]
                }],
                properties: ['dealname', 'teamleader_id']
            });

            if (dealSearchRes.data.results.length > 0) {
                hubspotDealId = dealSearchRes.data.results[0].id;
                await hubspot.patch(`/crm/v3/objects/deals/${hubspotDealId}`, hubspotDeal);
                console.log('🔄 Updated deal in HubSpot:', hubspotDealId, hubspotDeal.properties.dealname);
            } else {
                const response = await hubspot.post('/crm/v3/objects/deals', hubspotDeal);
                hubspotDealId = response.data.id;
                console.log('✅ Created deal in HubSpot:', hubspotDealId, hubspotDeal.properties.dealname);
            }
        } catch (error) {
            console.error('❌ Error syncing deal:', hubspotDeal.properties.dealname, error.response?.data || error.message);
            continue;
        }

        // Associate contact with deal
        if (hubspotContactId && hubspotDealId) {
            try {
                await hubspot.put(`/crm/v3/objects/deals/${hubspotDealId}/associations/contacts/${hubspotContactId}/deal_to_contact`, {});
                console.log(`🔗 Associated contact (${hubspotContactId}) with deal (${hubspotDealId})`);
            } catch (assocErr) {
                console.error('❌ Error associating contact with deal:', assocErr.response?.data || assocErr.message);
            }
        }

        // Sync company
        let hubspotCompanyId = null;
        const company = deal.company_details;
        if (company && company.name) {
            try {
                // Search for company by name (or use a more unique property if available)
                let companyFilter = [];
                if (company.vat_number) {
                    companyFilter.push({ propertyName: 'vat_number', operator: 'EQ', value: company.vat_number });
                } else if (company.domain) {
                    companyFilter.push({ propertyName: 'domain', operator: 'EQ', value: company.domain });
                } else {
                    companyFilter.push({ propertyName: 'name', operator: 'EQ', value: company.name });
                }
                const companySearchRes = await hubspot.post('/crm/v3/objects/companies/search', {
                    filterGroups: [{ filters: companyFilter }],
                    properties: ['name', 'vat_number', 'domain']
                });

                if (companySearchRes.data.results.length > 0) {
                    hubspotCompanyId = companySearchRes.data.results[0].id;
                    await hubspot.patch(`/crm/v3/objects/companies/${hubspotCompanyId}`, {
                        properties: {
                            name: company.name,
                            vat_number: company.vat_number || '',
                            domain: company.domain || ''
                            // ...other mappings
                        }
                    });
                } else {
                    const companyRes = await hubspot.post('/crm/v3/objects/companies', {
                        properties: {
                            name: company.name,
                            vat_number: company.vat_number || '',
                            domain: company.domain || ''
                            // Add more mappings if needed
                        }
                    });
                    hubspotCompanyId = companyRes.data.id;
                }
            } catch (error) {
                console.error(
                    '❌ Error syncing company:', 
                    company.name, 
                    JSON.stringify(error.response?.data, null, 2), 
                    error.response?.data?.errors, 
                    error.response?.data?.validationResults
                );
            }
        }

        // Associate deal with company in HubSpot
        if (hubspotCompanyId && hubspotDealId) {
            try {
                await hubspot.put(`/crm/v3/objects/deals/${hubspotDealId}/associations/companies/${hubspotCompanyId}/deal_to_company`, {});
                console.log(`🔗 Associated company (${hubspotCompanyId}) with deal (${hubspotDealId})`);
            } catch (assocErr) {
                console.error('❌ Error associating company with deal:', assocErr.response?.data || assocErr.message);
            }
        }

        // await new Promise(res => setTimeout(res, 300)); // 300ms delay, might work to bypass rate limits
        // Uncomment the above line if you encounter rate limiting issues with HubSpot API
    }
}

// --- Express routes ---

app.get('/', (req, res) => {
    const authUrl = `https://app.teamleader.eu/oauth2/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=companies%20contacts%20deals%20users`;
    res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('No code found in query.');

    try {
        const accessToken = await fetchAccessToken(code);

        // Remove progress file logic
        const startPage = parseInt(process.env.START_PAGE) || 1500; // Default to 1500 if not set
        const totalPages = parseInt(process.env.TOTAL_PAGES) || 3221; // Default to 3221 if not set
        const recordsPerPage = parseInt(process.env.RECORDS_PER_PAGE) || 10; // Default to SIZE if not set
        
        let allDealsWithPipeline = [];

        // Remove progress loading
        // let lastProcessedPage = loadProgress();
        // if (lastProcessedPage) {
        //     console.log(`Resuming from last processed page: ${lastProcessedPage}`);
        //     startPage = lastProcessedPage;
        // }

        for (let pageNumber = startPage; pageNumber <= totalPages; pageNumber++) {
            console.log(`
===============================
🔄 Processing page ${pageNumber} of ${totalPages}
===============================
            `);
            const deals = await fetchDeals(accessToken, pageNumber, recordsPerPage);

            // Fetch phases
            const phaseIds = [...new Set(deals.map(deal => deal.current_phase && deal.current_phase.id).filter(Boolean))];
            const phases = await fetchPhases(accessToken, phaseIds);
            const phaseMap = {};
            phases.forEach(phase => { phaseMap[phase.id] = phase; });

            // Fetch details for each deal
            const dealsWithAllDetails = [];
            for (const deal of deals) {
                let contactDetails = null;
                let companyDetails = null;
                let responsibleUserDetails = null;

                // 1. Try deal.lead.contact_person
                const contactPersonId = deal.lead.contact_person?.id;
                if (contactPersonId) {
                    contactDetails = await fetchContact(accessToken, contactPersonId);
                }

                // 2. Try deal.lead.customer if it's a contact
                if (!contactDetails && deal.lead.customer?.type === 'contact') {
                    contactDetails = await fetchContact(accessToken, deal.lead.customer.id);
                }

                // 3. Try deal.customer_details.contact_id
                if (!contactDetails && deal.customer_details?.contact_id) {
                    contactDetails = await fetchContact(accessToken, deal.customer_details.contact_id);
                }

                // 4. Try deal.contact_id
                if (!contactDetails && deal.contact_id) {
                    contactDetails = await fetchContact(accessToken, deal.contact_id);
                }

                // 5. Log if still missing
                if (!contactDetails) {
                    console.warn('⚠️ No contact found for deal:', deal.id, JSON.stringify(deal, null, 2));
                }

                // 3. Try to fetch company via deal.lead.customer if it's a company
                if (deal.lead.customer?.type === 'company') {
                    companyDetails = await fetchCompany(accessToken, deal.lead.customer.id);
                }

                // 4. Fallback: If contact has company_id, fetch that company
                if (!companyDetails && contactDetails && contactDetails.company_id) {
                    companyDetails = await fetchCompany(accessToken, contactDetails.company_id);
                }

                // 5. Fallback: If deal has company_id directly, fetch that company
                if (!companyDetails && deal.company_id) {
                    companyDetails = await fetchCompany(accessToken, deal.company_id);
                }

                // 6. Fallback: If deal has customer_details with company_id
                if (!companyDetails && deal.customer_details?.company_id) {
                    companyDetails = await fetchCompany(accessToken, deal.customer_details.company_id);
                }

                // 7. Fetch responsible user details if available
                if (deal.responsible_user?.id) {
                    responsibleUserDetails = await fetchUser(accessToken, deal.responsible_user.id);
                }

                dealsWithAllDetails.push({
                    ...deal,
                    contact_details: contactDetails,
                    company_details: companyDetails,
                    current_phase_details: phaseMap[deal.current_phase?.id] || null,
                    responsible_user_details: responsibleUserDetails,
                    customer_details: companyDetails // for compatibility
                });
            }

            // Fetch pipelines
            const pipelineIds = [...new Set(deals.map(deal => deal.pipeline && deal.pipeline.id).filter(Boolean))];
            let pipelines = [];
            if (pipelineIds.length > 0) {
                const pipelinesData = JSON.stringify({
                    filter: { ids: pipelineIds },
                    page: { size: pipelineIds.length, number: 1 }
                });
                const pipelinesRes = await axios.post(
                    'https://api.focus.teamleader.eu/dealPipelines.list',
                    pipelinesData, {
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'application/json',
                            'Authorization': `Bearer ${accessToken}`
                        }
                    }
                );
                pipelines = pipelinesRes.data.data || [];
            }
            const pipelineMap = {};
            pipelines.forEach(pipeline => { pipelineMap[pipeline.id] = pipeline; });

            const dealsWithPipeline = dealsWithAllDetails.map(deal => ({
                ...deal,
                pipeline_details: pipelineMap[deal.pipeline?.id] || null
            }));

            allDealsWithPipeline = allDealsWithPipeline.concat(dealsWithPipeline);

            // Print the entire scope of records for this loop to the console
            // console.log(JSON.stringify(dealsWithPipeline, null, 2));

            // Sync deals to HubSpot
            await syncDealsToHubspot(dealsWithPipeline);

            // Remove progress saving
            // saveProgress(pageNumber);
        }

        res.send(`<pre>${JSON.stringify(allDealsWithPipeline, null, 2)}</pre>`);
        console.log('✅ Sync finished. All deals processed and sent to browser.');
    } catch (err) {
        res.status(500).send('Error: ' + (err.response ? JSON.stringify(err.response.data) : err.message));
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});