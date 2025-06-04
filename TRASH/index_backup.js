// server.js - Geherstructureerd voor Teamleader → HubSpot sync met eenvoudige webinterface
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const app = express();

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;

let accessToken = '';

// Aantal te synchroniseren records beperken (voor testing)
const SYNC_LIMIT = 10;

app.use(express.json());

const teamleader = () =>
  axios.create({
    baseURL: 'https://api.teamleader.eu',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

function logSyncAction({ type, id, action, message, error = null }) {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, type, id, action, message, error };
  fs.appendFileSync('sync-log.jsonl', JSON.stringify(entry) + '\n');
}

function mapStatusToHubspotStage(status) {
  switch (status.toLowerCase()) {
    case 'won': return 'decisionmakerboughtin';
    case 'lost': return 'closedlost';
    default: return 'appointmentscheduled';
  }
}

function shouldSyncByDate(updated_at, maxYears = 5) {
  const diffYears = (Date.now() - new Date(updated_at)) / (1000 * 60 * 60 * 24 * 365);
  return diffYears < maxYears || Math.abs(diffYears - maxYears) < 0.01; // inclusief 2 of 5 jaar exact
}

async function getRecentContacts(limit = SYNC_LIMIT) {
  const response = await teamleader().post('/contacts.list', {
    page: { size: limit, number: 1 }
  });
  return response.data.data || [];
}

async function getContactDetails(contactId) {
  const res = await teamleader().post('/contacts.info', { id: contactId });
  return res.data.data;
}

async function getDealsForContact(contactId) {
  const res = await teamleader().post('/deals.list', {
    filter: { customer: { id: contactId, type: 'contact' } }
  });
  return res.data.data || [];
}

async function searchHubspotContact(email) {
  const res = await axios.post(
    'https://api.hubapi.com/crm/v3/objects/contacts/search',
    { filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }] },
    { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
  );
  return res.data.total > 0 ? res.data.results[0] : null;
}

async function createOrUpdateHubspotContact(contact, deals) {
  const email = contact.emails?.[0]?.email;
  if (!email) return logSyncAction({ type: 'contact', id: contact.id, action: 'skip', message: 'No email' });

  const existing = await searchHubspotContact(email);
  const updatedYears = (Date.now() - new Date(contact.updated_at)) / (1000 * 60 * 60 * 24 * 365);

  if (updatedYears > 5) return logSyncAction({ type: 'contact', id: contact.id, action: 'skip', message: '>5y old' });

  const companyName = contact.company?.name || '';

  const props = {
    email,
    firstname: contact.first_name,
    lastname: contact.last_name,
    phone: contact.telephones?.[0]?.number || '',
    jobtitle: contact.job_title || '',
    hs_language: contact.language || '',
    company: companyName
  };

  try {
    if (existing) {
      await axios.patch(`https://api.hubapi.com/crm/v3/objects/contacts/${existing.id}`,
        { properties: props }, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } });
      logSyncAction({ type: 'contact', id: contact.id, action: 'update', message: 'Updated in HubSpot' });
      return existing.id;
    } else {
      const res = await axios.post('https://api.hubapi.com/crm/v3/objects/contacts',
        { properties: props }, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } });
      logSyncAction({ type: 'contact', id: contact.id, action: 'create', message: 'Created in HubSpot' });
      const hubspotContactId = res.data.id;
      if (contact.company && contact.company.id) {
      logSyncAction({ type: 'company', id: contact.company.id, action: 'linked-from-contact', message: `Contact ${contact.id} has linked company ID ${contact.company.id}` });
      let company;
      try {
        company = await getCompanyDetails(contact.company.id);
      } catch (err) {
        logSyncAction({ type: 'company', id: contact.company.id, action: 'error', message: 'Failed to fetch company details from Teamleader (during contact sync)', error: err.response?.data || err.message });
        return hubspotContactId;
      }
        const hubspotCompany = await searchHubspotCompany(company);
        if (!hubspotCompany) {
        logSyncAction({ type: 'company', id: company.id, action: 'skip', message: 'Company not found in HubSpot during contact sync' });
      } else {
          await axios.put(
            `https://api.hubapi.com/crm/v3/objects/contacts/${hubspotContactId}/associations/companies/${hubspotCompany.id}/contact_to_company`,
            {},
            { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
          );
        }
      }
      return hubspotContactId;
    }
  } catch (err) {
    logSyncAction({ type: 'contact', id: contact.id, action: 'error', message: 'HubSpot contact sync failed', error: err.response?.data || err.message });
  }
}

async function searchHubspotDealByTitle(title) {
  try {
    const res = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/deals/search',
      {
        filterGroups: [
          {
            filters: [
              {
                propertyName: 'dealname',
                operator: 'EQ',
                value: title
              }
            ]
          }
        ]
      },
      { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
    );
    return res.data.total > 0 ? res.data.results[0] : null;
  } catch (err) {
    console.error('❌ Error searching deal:', err.response?.data || err.message);
    return null;
  }
}

async function syncDeals(deals, contactId) {
  for (const deal of deals) {
    const updatedYears = (Date.now() - new Date(deal.updated_at)) / (1000 * 60 * 60 * 24 * 365);
    const isOld = updatedYears > 5;
    const isInactive = updatedYears >= 2 && updatedYears <= 5 && deal.status !== 'open';
    if (isOld) {
      logSyncAction({ type: 'deal', id: deal.id, action: 'skip', message: 'Deal >5y old' });
      continue;
    }

    const props = {
      dealname: deal.title || 'No title',
      amount: deal.estimated_value?.amount || 0,
      dealstage: mapStatusToHubspotStage(deal.status),
      closedate: new Date(deal.created_at).toISOString(),
    };

    try {
      const existingDeal = await searchHubspotDealByTitle(deal.title);

      if (existingDeal) {
        await axios.patch(
          `https://api.hubapi.com/crm/v3/objects/deals/${existingDeal.id}`,
          { properties: props },
          { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
        );
        logSyncAction({ type: 'deal', id: deal.id, action: 'update', message: 'Deal updated in HubSpot' });

        await axios.put(
          `https://api.hubapi.com/crm/v3/objects/deals/${existingDeal.id}/associations/contacts/${contactId}/deal_to_contact`,
          {},
          { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
        );
      } else {
        const dealRes = await axios.post(
          'https://api.hubapi.com/crm/v3/objects/deals',
          { properties: props },
          { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
        );

        const hubspotDealId = dealRes.data.id;
        await axios.put(
          `https://api.hubapi.com/crm/v3/objects/deals/${hubspotDealId}/associations/contacts/${contactId}/deal_to_contact`,
          {},
          { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
        );

        logSyncAction({ type: 'deal', id: deal.id, action: 'create', message: `Deal created and linked to contact ${contactId}` });
      }
    } catch (err) {
      logSyncAction({ type: 'deal', id: deal.id, action: 'error', message: 'HubSpot deal sync failed', error: err.response?.data || err.message });
    }
  }
}

async function getCompanyDetails(companyId) {
  const res = await teamleader().post('/companies.info', { id: companyId });
  return res.data.data;
}

async function searchHubspotCompany(company) {
  const searchAttempts = [
    { property: 'vat_number', value: company.vat_number },
    { property: 'domain', value: company.website },
    { property: 'name', value: company.name }
  ];

  for (const attempt of searchAttempts) {
    if (!attempt.value) continue;

    try {
      const res = await axios.post(
        'https://api.hubapi.com/crm/v3/objects/companies/search',
        {
          filterGroups: [
            {
              filters: [
                {
                  propertyName: attempt.property,
                  operator: 'EQ',
                  value: attempt.value
                }
              ]
            }
          ]
        },
        { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
      );
      if (res.data.total > 0) return res.data.results[0];
    } catch (err) {
      console.error(`Error searching company by ${attempt.property}:`, err.message);
    }
  }
  return null;
}

async function createOrUpdateHubspotCompany(company, linkedContactIds = []) {
  logSyncAction({ type: 'company', id: company.id, action: 'info', message: `Preparing sync for company: ${company.name} | VAT: ${company.vat_number || 'n/a'} | Website: ${company.website || 'n/a'}` });
  const props = {
    name: company.name,
    vat_number: company.vat_number || '',
    domain: company.website || '',
    city: company.address?.locality || '',
    address: company.address?.line_1 || '',
    country: company.address?.country || ''
  };

  try {
    const existing = await searchHubspotCompany(company);
    let hubspotCompanyId;

    if (existing) {
      await axios.patch(
        `https://api.hubapi.com/crm/v3/objects/companies/${existing.id}`,
        { properties: props },
        { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
      );
      hubspotCompanyId = existing.id;
      logSyncAction({ type: 'company', id: company.id, action: 'update', message: 'Company updated in HubSpot' });
    } else {
      const res = await axios.post(
        'https://api.hubapi.com/crm/v3/objects/companies',
        { properties: props },
        { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
      );
      hubspotCompanyId = res.data.id;
      logSyncAction({ type: 'company', id: company.id, action: 'create', message: 'Company created in HubSpot' });
    }

    // Link all synced contacts to this company
    for (const contactId of linkedContactIds) {
      await axios.put(
        `https://api.hubapi.com/crm/v3/objects/companies/${hubspotCompanyId}/associations/contacts/${contactId}/company_to_contact`,
        {},
        { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
      );
    }
  } catch (err) {
    logSyncAction({ type: 'company', id: company.id, action: 'error', message: 'HubSpot company sync failed', error: err.response?.data || err.message });
  }
}

app.post('/sync', async (req, res) => {
  if (!accessToken) {
    return res.status(401).send('❌ Access token ontbreekt. Ga eerst naar / om in te loggen bij Teamleader.');
  }
  try {
    const contacts = await getRecentContacts();
    const syncedContacts = [];
    const companyMap = new Map(); // Map<companyId, [hubspotContactIds]>

    for (const contact of contacts) {
      const full = await getContactDetails(contact.id);
      logSyncAction({
        type: 'company',
        id: full.company?.id || '-',
        action: full.company?.id ? 'contact-company-detected' : 'no-company',
        message: full.company?.id ? `Contact ${full.id} is linked to company ID ${full.company.id}` : `Contact ${full.id} has no company`
      });
      if (!shouldSyncByDate(full.updated_at)) {
        logSyncAction({ type: 'contact', id: full.id, action: 'skip', message: 'Not recently updated' });
        continue;
      }

      const deals = await getDealsForContact(contact.id);
      const hubspotContactId = await createOrUpdateHubspotContact(full, deals);

      if (hubspotContactId) {
        syncedContacts.push({ teamleaderId: contact.id, hubspotId: hubspotContactId });
        await syncDeals(deals, hubspotContactId);

        if (full.company && full.company.id) {
        logSyncAction({ type: 'company', id: full.company.id, action: 'check', message: `Contact ${full.id} heeft gekoppeld bedrijf: ${full.company.name || 'onbekend naam'}` });
          const current = companyMap.get(full.company.id) || [];
          current.push(hubspotContactId);
          companyMap.set(full.company.id, current);
        }
      }
    }

    for (const [companyId, hubspotContactIds] of companyMap.entries()) {
      logSyncAction({ type: 'company', id: companyId, action: 'lookup', message: 'Checking companyMap entry for sync' });
      let company = null;
      try {
        company = await getCompanyDetails(companyId);
      } catch (err) {
        logSyncAction({ type: 'company', id: companyId, action: 'error', message: 'Error retrieving company from Teamleader', error: err.response?.data || err.message });
        continue;
      }

      if (!company) {
        logSyncAction({ type: 'company', id: companyId, action: 'skip', message: 'Company not found in Teamleader' });
        continue;
      }

      logSyncAction({ type: 'company', id: companyId, action: 'retrieved', message: `Retrieved company: ${company.name}` });

      try {
        await createOrUpdateHubspotCompany(company, hubspotContactIds);
      } catch (err) {
        logSyncAction({ type: 'company', id: companyId, action: 'error', message: 'Error during HubSpot company sync', error: err.response?.data || err.message });
      }
    }

    const logContent = fs.readFileSync('sync-log.jsonl', 'utf8');
    const html = `
      <html>
        <head><title>Sync Result</title></head>
        <body style="font-family: monospace; white-space: pre; padding: 20px;">
          <h2>✅ Sync Completed</h2>
          <p>Below is a dump of all log entries:</p>
          <hr>
          ${logContent.replace(/</g, '&lt;')}
        </body>
      </html>
    `;
    res.send(html);
  } catch (err) {
    console.error(err);
    const status = err.response?.status || 500;
    const message = err.response?.data?.message || err.message || 'Onbekende fout';
    const code = err.response?.data?.errors?.[0]?.code || null;
    const logMessage = `❌ Sync error (${status})${code ? ` [${code}]` : ''}: ${message}`;
    logSyncAction({ type: 'sync', id: '-', action: 'error', message: logMessage, error: err.response?.data || err.message });
    res.status(status).send(logMessage);
  }
});

// Eenvoudige webinterface
app.get('/interface', (req, res) => {
  res.send(`
    <html>
      <head><title>Teamleader → HubSpot Sync</title></head>
      <body style="font-family:sans-serif; padding:20px;">
        <h2>Teamleader → HubSpot Sync Interface</h2>
        <form action="/sync" method="POST">
          <button type="submit" style="padding:10px 20px; font-size:16px;">Start Sync</button>
        </form>
      </body>
    </html>
  `);
});

app.get('/', (req, res) => {
  accessToken = '';
  const url = `https://focus.teamleader.eu/oauth2/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=contacts deals`;
  res.redirect(url);
});

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  try {
    const tokenRes = await axios.post('https://focus.teamleader.eu/oauth2/access_token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    accessToken = tokenRes.data.access_token;
    res.redirect('/interface');
  } catch (err) {
    res.status(500).send('❌ Token error: ' + (err.response?.data || err.message));
  }
});

app.listen(3000, () => {
  console.log('🚀 Server running on http://localhost:3000');
});
