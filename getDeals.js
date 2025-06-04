const express = require('express');
const axios = require('axios');
require('dotenv').config();


const PORT = 3000;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/callback';
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const API_BASE_URL = process.env.API_BASE_URL || 'https://api.teamleader.eu';

const app = express();

// STEP 1: Start OAuth2 flow

const authUrl = `https://app.teamleader.eu/oauth2/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=companies%20contacts%20deals%20users`;

app.get('/', (req, res) => {
	// Automatically redirect to the Teamleader OAuth authorization URL
	res.redirect(authUrl);
});

// STEP 2: Handle OAuth2 callback and fetch deals

app.get('/callback', async (req, res) => {
	const code = req.query.code;

	if (!code) {
		return res.status(400).send('No code found in query.');
	}
	try {
		// Exchange code for access token
		const tokenRes = await axios.post('https://app.teamleader.eu/oauth2/access_token', null, {
		params: {
			grant_type: 'authorization_code',
			code,
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			redirect_uri: REDIRECT_URI
		}
		});
		const accessToken = tokenRes.data.access_token;

		const SIZE = 10;
		const totalPages = 3221;
		
		let allDealsWithPipeline = [];

		for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {

		const dealsData = JSON.stringify({
			filter: {},
			page: { size: SIZE, number: pageNumber },
			sort: [{ field: "created_at", order: "desc" }]
		});

		const dealsRes = await axios.post(
			'https://api.focus.teamleader.eu/deals.list',
			dealsData,
			{
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json',
				'Authorization': `Bearer ${accessToken}`
			}
			}
		);

		const deals = dealsRes.data.data || [];

		const phaseIds = [
			...new Set(
			deals
				.map(deal => deal.current_phase && deal.current_phase.id)
				.filter(Boolean)
			)
		];

		// Fetch phase details
		let phases = [];
		if (phaseIds.length > 0) {
			const phasesData = JSON.stringify({
			filter: { ids: phaseIds },
			page: { size: phaseIds.length, number: 1 }
			});

			const phasesRes = await axios.post(
			'https://api.focus.teamleader.eu/dealPhases.list',
			phasesData,
			{
				headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json',
				'Authorization': `Bearer ${accessToken}`
				}
			}
			);
			phases = phasesRes.data.data || [];
		}

		// Map phase info to deals
		const phaseMap = {};
		phases.forEach(phase => {
			phaseMap[phase.id] = phase;
		});

		// Fetch responsible user details for each deal
		const dealsWithAllDetails = [];
		for (const deal of deals) {
			let customerDetails = null;
			let responsibleUserDetails = null;

			// Fetch customer details
			const customerId = deal.lead.customer?.id;
			if (customerId) {
			try {
				const contactRes = await axios.post(
				'https://api.focus.teamleader.eu/contacts.info',
				JSON.stringify({ id: customerId }),
				{
					headers: {
					'Content-Type': 'application/json',
					'Accept': 'application/json',
					'Authorization': `Bearer ${accessToken}`
					}
				}
				);
				customerDetails = contactRes.data.data || null;
			} catch (e) {
				customerDetails = { error: e.response?.data || e.message };
			}
			}

			// Fetch responsible user details
			const responsibleUserId = deal.responsible_user?.id;
			if (responsibleUserId) {
			try {
				const userRes = await axios.post(
				'https://api.focus.teamleader.eu/users.info',
				JSON.stringify({ id: responsibleUserId, includes: "external_rate" }),
				{
					headers: {
					'Content-Type': 'application/json',
					'Accept': 'application/json',
					'Authorization': `Bearer ${accessToken}`
					}
				}
				);
				responsibleUserDetails = userRes.data.data || null;
			} catch (e) {
				responsibleUserDetails = { error: e.response?.data || e.message };
			}
			}

			dealsWithAllDetails.push({
			...deal,
			current_phase_details: phaseMap[deal.current_phase?.id] || null,
			customer_details: customerDetails,
			responsible_user_details: responsibleUserDetails
			});
		}

		// 1. Collect unique pipeline IDs from deals
		const pipelineIds = [
			...new Set(
			deals.map(deal => deal.pipeline && deal.pipeline.id).filter(Boolean)
			)
		];

		// 2. Fetch pipeline details from Teamleader Focus
		let pipelines = [];
		if (pipelineIds.length > 0) {
			const pipelinesData = JSON.stringify({
			filter: { ids: pipelineIds },
			page: { size: pipelineIds.length, number: 1 }
			});

			const pipelinesRes = await axios.post(
			'https://api.focus.teamleader.eu/dealPipelines.list',
			pipelinesData,
			{
				headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json',
				'Authorization': `Bearer ${accessToken}`
				}
			}
			);
			pipelines = pipelinesRes.data.data || [];
		}

		// 3. Map pipeline info to deals
		const pipelineMap = {};
		pipelines.forEach(pipeline => {
			pipelineMap[pipeline.id] = pipeline;
		});

		const dealsWithPipeline = dealsWithAllDetails.map(deal => ({
			...deal,
			pipeline_details: pipelineMap[deal.pipeline?.id] || null
		}));

		// Add to our collection
		allDealsWithPipeline = allDealsWithPipeline.concat(dealsWithPipeline);

		// Print to console
		console.log(JSON.stringify(dealsWithPipeline, null, 2));

		

		// Sync deals to HubSpot
		await syncDealsToHubspot(dealsWithPipeline);
		}

		// Also show in browser
		res.send(`<pre>${JSON.stringify(allDealsWithPipeline, null, 2)}</pre>`);
	} catch (err) {
		res.status(500).send('Error: ' + (err.response ? JSON.stringify(err.response.data) : err.message));
	}
});

const hubspot = axios.create({
	baseURL: 'https://api.hubapi.com',
	headers: {
		Authorization: `Bearer ${HUBSPOT_TOKEN}`,
		'Content-Type': 'application/json',
	},
	timeout: 60000,
});

// Map Teamleader status to HubSpot stage
function mapTeamleaderStatusToHubspotStage(status, phaseName) {
	// Convert phase name to lowercase for case-insensitive comparison
	const phase = phaseName?.toLowerCase() || '';
	
	// Map based on phase name
	if (phase.includes('nieuw')) return 'appointmentscheduled';
	if (phase.includes('offerte verzonden')) return 'contractsent';
	if (phase.includes('contact na offerte')) return 'presentationscheduled';
	if (phase.includes('on hold')) return 'decisionmakerboughtin';
	
	// Map based on status
	switch (status) {
		case 'won':
		return 'closedwon';
		case 'lost':
		return 'closedlost';
		case 'open':
		default:
		return 'appointmentscheduled';
	}
}

// Determine if deal is for new or existing business
function determineDealType(deal) {
	// Check if the customer exists in Teamleader
	const customerId = deal.lead?.customer?.id;
	if (!customerId) {
		return 'newbusiness'; // No customer ID means it's a new business
	}

	// Check if the customer has any existing deals
	const customerDeals = deal.customer_details?.deals || [];
	const existingDeals = customerDeals.filter(d => d.id !== deal.id); // Exclude current deal

	// If customer has other deals, it's existing business
	return existingDeals.length > 0 ? 'existingbusiness' : 'newbusiness';
}

// Map Teamleader deal to HubSpot deal properties
function mapTeamleaderDealToHubspot(deal) {
	console.log(deal);
	return {
		properties: {
		dealname: deal.title || 'Teamleader Deal',
		description: deal.summary || '',
		amount: deal.estimated_value?.amount ? String(deal.estimated_value.amount) : undefined,
		//closedate: deal.closed_at || deal.estimated_closing_date || Date.now(), // bestaat niet in teamleader
		pipeline: 'default',
		dealstage: mapTeamleaderStatusToHubspotStage(deal.status, deal.current_phase_details?.name),
		dealtype: determineDealType(deal),
		//description: deal.description || '', // bestaat niet in teamleader
		//hs_createdate: deal.created_at || Date.now(),
		//hs_lastmodifieddate: deal.updated_at || Date.now(), // niet nodig? aangezien we deal_last_update gebruiken
		deal_last_update: deal.updated_at
		}
	};
}

// Call this after you have your deals array
async function syncDealsToHubspot(deals) {
	const now = new Date();
	const fiveYearsAgo = new Date(now);
	fiveYearsAgo.setFullYear(now.getFullYear() - 5);
	const twoYearsAgo = new Date(now);
	twoYearsAgo.setFullYear(now.getFullYear() - 2);

	for (const deal of deals) {

		const updatedAt = deal.updated_at ? new Date(deal.updated_at) : null;
		if (!updatedAt || updatedAt < fiveYearsAgo) {
		// Skip deals older than 5 years
		continue;
		}

		// Determine marketing contact status
		let marketingStatus = undefined;
		if (updatedAt > twoYearsAgo) {
		marketingStatus = true;
		} else {
		marketingStatus = false;
		}



		// 1. Sync associated contact to HubSpot
		let hubspotContactId = null;
		const contact = deal.customer_details;

		let contactEmail = undefined;
		if (Array.isArray(contact.emails) && contact.emails.length > 0) {
		contactEmail = contact.emails.find(c => c.type === 'primary')?.email || contact.emails[0].email;
		}

		console.log(contactEmail);

		if (contactEmail) {
		try {
			// First, search for the contact by email
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
			// Contact exists, update it
			hubspotContactId = searchRes.data.results[0].id;
			await hubspot.patch(`/crm/v3/objects/contacts/${hubspotContactId}`, {
				properties: {
				email: contactEmail,
				firstname: contact.first_name || contact.firstname,
				lastname: contact.last_name || contact.lastname,
				phone: contact.telephone || contact.phone,
				// Add more mappings as needed
				hs_marketable_status: marketingStatus || ''
				}
			});
			} else {
			// Contact does not exist, create it
			const contactRes = await hubspot.post('/crm/v3/objects/contacts', {
				properties: {
				email: contactEmail,
				firstname: contact.first_name || contact.firstname,
				lastname: contact.last_name || contact.lastname,
				phone: contact.telephone || contact.phone,
				// Add more mappings as needed
				}
			});
			hubspotContactId = contactRes.data.id;
			}
		} catch (error) {
			console.error('❌ Error syncing contact:', contactEmail, error.response?.data || error.message);
		}
		}

		// 2. Sync deal to HubSpot (search, update or create)
		const hubspotDeal = mapTeamleaderDealToHubspot(deal);
		let hubspotDealId = null;
		try {
		// Search for the deal by name (and optionally other unique properties)
		const dealSearchRes = await hubspot.post('/crm/v3/objects/deals/search', {
			filterGroups: [{
			filters: [{ 
				propertyName: 'dealname',
				operator: 'EQ',
				value: hubspotDeal.properties.dealname
			}]
			}],
			properties: ['dealname']
		});
		if (dealSearchRes.data.results.length > 0) {
			// Deal exists, update it
			hubspotDealId = dealSearchRes.data.results[0].id;
			await hubspot.patch(`/crm/v3/objects/deals/${hubspotDealId}`, hubspotDeal);
			console.log('🔄 Updated deal in HubSpot:', hubspotDealId, hubspotDeal.properties.dealname);
		} else {
			// Deal does not exist, create it
			const response = await hubspot.post('/crm/v3/objects/deals', hubspotDeal);
			hubspotDealId = response.data.id;
			console.log('✅ Created deal in HubSpot:', hubspotDealId, hubspotDeal.properties.dealname);
		}
		} catch (error) {
		console.error('❌ Error syncing deal:', hubspotDeal.properties.dealname, error.response?.data || error.message);
		continue; // Skip association if deal creation failed
		}

		// ...after creating/updating deal...
		console.log(`Deal synced: ${hubspotDealId}`);

		// 3. Associate contact with deal in HubSpot
		if (hubspotContactId && hubspotDealId) {
		try {
			await hubspot.put(`/crm/v3/objects/deals/${hubspotDealId}/associations/contacts/${hubspotContactId}/deal_to_contact`, {});
			console.log(`🔗 Associated contact (${hubspotContactId}) with deal (${hubspotDealId})`);
		} catch (assocErr) {
			console.error('❌ Error associating contact with deal:', assocErr.response?.data || assocErr.message);
		}
		}

		// ...after associating contact...
		console.log(`Associated contact ${hubspotContactId} with deal ${hubspotDealId}`);

	}
}

app.listen(PORT, () => {
  	console.log(`Server running at http://localhost:${PORT}`);
});