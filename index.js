require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;

let accessToken = '';
let latestRecords = [];

const teamleader = () =>
  axios.create({
    baseURL: 'https://api.teamleader.eu',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

const hubspot = axios.create({
  baseURL: 'https://api.hubapi.com',
  headers: {
    Authorization: `Bearer ${HUBSPOT_TOKEN}`,
    'Content-Type': 'application/json',
  },
});

app.get('/', (req, res) => {
  const url = `https://focus.teamleader.eu/oauth2/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=contacts+deals`;
  res.send(`Open <a href="${url}">Teamleader OAuth</a> om verbinding te maken`);
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
    res.send('✅ OAuth succesvol! Je kunt nu <a href="/sync-contacts">/sync-contacts</a>, <a href="/random-contact">/random-contact</a> of <a href="/sync-deals">/sync-deals</a> bezoeken.');
  } catch (err) {
    res.status(500).send('❌ OAuth fout: ' + JSON.stringify(err.response?.data || err.message));
  }
});

app.get('/sync-contacts', async (req, res) => {
  if (!accessToken) return res.redirect('/');
  latestRecords = await syncContacts();

  const headers = Object.keys(latestRecords[0] || {});
  const rows = latestRecords.map(r => `<tr>${headers.map(h => `<td>${r[h] || ''}</td>`).join('')}</tr>`).join('\n');

  const table = `
    <table border="1" cellpadding="5" cellspacing="0">
      <thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  res.send(`<h1>📋 Gesynchroniseerde contacten</h1>${table}`);
});

app.get('/random-contact', async (req, res) => {
  if (!accessToken) return res.redirect('/');
  const contactsResponse = await teamleader().post('/contacts.list', {
    page: { size: 100, number: 1 }
  });
  const contacts = contactsResponse.data.data;
  const randomContact = contacts[Math.floor(Math.random() * contacts.length)];

  const infoResponse = await teamleader().post('/contacts.info', { id: randomContact.id });
  const info = infoResponse.data.data;

  const dealsResponse = await teamleader().post('/deals.list', {
    filter: { contact_id: randomContact.id },
    page: { size: 10, number: 1 }
  });
  const deals = dealsResponse.data.data;

  const dealDetails = deals.length > 0
    ? (await teamleader().post('/deals.info', { id: deals[0].id })).data.data
    : null;

  res.json({ contact: info, deal: dealDetails.current_phase });
});


function formatToMidnightISOString(dateString) {
  if (!dateString) return null;
  const date = new Date(dateString);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

function validateHubspotFields(fields) {
  const validated = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined || Number.isNaN(value)) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    validated[key] = value;
  }
  return validated;
}

async function syncContacts() {
  const contactsResponse = await teamleader().post('/contacts.list', {
    page: { size: 100, number: 1 }
  });
  const contacts = contactsResponse.data.data;

  const MAX_SYNC = 1;
  let synced = 0;
  const records = [];

  for (const contact of contacts) {
    if (synced >= MAX_SYNC) break;

    const infoResponse = await teamleader().post('/contacts.info', { id: contact.id });
    const info = infoResponse.data.data;
    const email = info.emails?.[0]?.email;
    if (!email) continue;

    const dealsResponse = await teamleader().post('/deals.list', {
      filter: { contact_id: contact.id },
      page: { size: 100, number: 1 }
    });
    let deals = dealsResponse.data.data;

    deals.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    let contactStatus = 'Onbekend';
    if (deals.some(d => d.status === 'won')) {
      contactStatus = 'Klant';
    } else if (deals.length > 0) {
      contactStatus = 'Prospect';
    }

    const dealDetails = deals.length > 0
      ? (await teamleader().post('/deals.info', { id: deals[0].id })).data.data
      : null;

    if (dealDetails) {
      console.log('📦 Deal details voor', email, ':', JSON.stringify(dealDetails, null, 2));
    }

    let phaseLabel = '';
    phaseLabel = dealDetails?.current_phase?.type || '';
    const weiVal = 'weighted: ' + dealDetails.weighted_value.amount + ' ' + dealDetails.weighted_value.currency;
    const estVal = 'est.: ' + dealDetails.estimated_value.amount + ' ' + dealDetails.estimated_value.currency;

    const customFields = dealDetails ? {
      deal_created_at: formatToMidnightISOString(dealDetails.created_at),
      deal_closed: formatToMidnightISOString(dealDetails.won_on || dealDetails.lost_on),
      deal_title: dealDetails.title || '',
      deal_phase: dealDetails.status || '',
      deal_value: weiVal + ' | ' + estVal || 0
    } : {};

    const data = validateHubspotFields({
      firstname: info.first_name,
      lastname: info.last_name,
      email: email,
      contact_status: contactStatus,
      ...customFields
    });

    try {
      const existing = await hubspot.get(`/crm/v3/objects/contacts?properties=email&limit=1&filterGroups=[{"filters":[{"propertyName":"email","operator":"EQ","value":"${email}"}]}]`);
      const existingContact = existing.data.results[0];

      if (existingContact) {
        await hubspot.patch(`/crm/v3/objects/contacts/${existingContact.id}`, {
          properties: data
        });
        console.log(`✏️ Bestaande contact bijgewerkt: ${email}`);
      } else {
        await hubspot.post('/crm/v3/objects/contacts', {
          properties: data
        });
        console.log(`🆕 Nieuw contact aangemaakt: ${email}`);
      }
    } catch (error) {
      console.error(`❌ Fout bij synchroniseren met HubSpot voor ${email}:`, error.response?.data || error.message);
    }

    
    records.push(data);
    synced++;
  }

  return records;
}

app.listen(3000, () => {
  console.log('🌐 Ga naar http://localhost:3000 om OAuth te starten');
});
