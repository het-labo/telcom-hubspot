require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;

let accessToken = '';

// Helper function to create Teamleader API client
const teamleader = () =>
  axios.create({
    baseURL: 'https://api.teamleader.eu',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    timeout: 60000
  });

// Helper function to create HubSpot API client
const hubspot = () =>
  axios.create({
    baseURL: 'https://api.hubapi.com',
    headers: {
      Authorization: `Bearer ${HUBSPOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    timeout: 60000
  });

// Add rate limiting helper
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to map Teamleader phase to HubSpot stage
function mapTeamleaderPhaseToHubspotStage(phaseName) {
  const phaseMapping = {
    'Phase 1': 'Nieuw',
    'Phase 2': 'Offerte verzonden',
    'Phase 3': 'Contact na offerte',
    'Phase 4': 'On hold',
    'Phase 5': 'Aanvaard'
  };
  return phaseMapping[phaseName] || 'appointmentscheduled';
}

// Helper function to get HubSpot owner ID based on email
function getHubspotOwnerId(email) {
  const ownerMapping = {
    'user1@example.com': '12345',
    'user2@example.com': '67890'
  };
  return ownerMapping[email] || null;
}

// Get Teamleader deals (paginated, simplified)
async function getAllDeals() {
  let allDeals = [];
  let page = 1;
  const MAX_RECORDS = 10;

  try {
    while (allDeals.length < MAX_RECORDS) {
      const response = await teamleader().post('/deals.list', {
        page: { size: 100 }
      });

      const deals = response.data.data || [];
      if (deals.length === 0) break;

      const remainingSlots = MAX_RECORDS - allDeals.length;
      allDeals = allDeals.concat(deals.slice(0, remainingSlots));
      if (allDeals.length >= MAX_RECORDS) break;

      page++;
      await delay(1000);
    }
    return allDeals;
  } catch (error) {
    console.error('❌ Error fetching deals:', error.response?.data || error.message);
    return allDeals;
  }
}

// Create HubSpot deal from Teamleader deal
async function createHubspotDeal(deal) {
  try {
    const hubspotDeal = {
      properties: {
        dealname: deal.title || `Deal ${deal.id}`,
        pipeline: 'default',
        dealstage: mapTeamleaderPhaseToHubspotStage(deal.phaseName),
        amount: deal.value || '0',
        createdate: new Date(deal.created_at).getTime(),
        closedate: deal.closed_at ? new Date(deal.closed_at).getTime() : null,
        hs_lastmodifieddate: new Date(deal.updated_at).getTime(),
        hubspot_owner_id: getHubspotOwnerId(deal.userDetails?.email),
        description: `Teamleader IDs:
          Deal ID: ${deal.id}
          Pipeline ID: ${deal.pipeline?.id || ''}
          Phase ID: ${deal.current_phase?.id || ''}
          Customer ID: ${deal.lead?.customer?.id || ''}
          Contact ID: ${deal.lead?.contact_person?.id || ''}
          Responsible User ID: ${deal.responsible_user?.id || ''}`,
        deal_status: 'actief'
      }
    };

    const response = await hubspot().post('/crm/v3/objects/deals', hubspotDeal);
    console.log(`✅ Created HubSpot deal with ID: ${response.data.id}`);
    return response.data;
  } catch (error) {
    console.error(`❌ Error creating HubSpot deal for Teamleader deal ${deal.id}:`, error.response?.data || error.message);
    return null;
  }
}

// Main sync function
async function syncTeamleaderToHubspot() {
  // TODO: Implement OAuth flow to get Teamleader accessToken before running this function
  if (!accessToken) {
    console.error('❌ Teamleader access token not set. Please authenticate first.');
    return;
  }
  const deals = await getAllDeals();
  for (const deal of deals) {
    await createHubspotDeal(deal);
    await delay(1000);
  }
  console.log('✅ Sync complete');
}

// Uncomment to run sync directly (ensure accessToken is set!)
// syncTeamleaderToHubspot();

module.exports = {
  syncTeamleaderToHubspot
};
