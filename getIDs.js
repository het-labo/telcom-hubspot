// index.js
require("dotenv").config();
const axios = require("axios");
const express = require('express');
const app = express();

const PORT = 3000;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3001/callback';
const API_URL = 'https://api.focus.teamleader.eu';

// STEP 1: Start OAuth2 flow
const authUrl = `https://app.teamleader.eu/oauth2/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=companies%20contacts%20deals`;

app.get('/', (req, res) => {
  res.redirect(authUrl);
});

// Helper to exchange authorization code for access token
async function getAccessTokenFromCode(code) {
  const params = new URLSearchParams();
  params.append('grant_type', 'authorization_code');
  params.append('client_id', CLIENT_ID);
  params.append('client_secret', CLIENT_SECRET);
  params.append('redirect_uri', REDIRECT_URI);
  params.append('code', code);
  const response = await axios.post('https://app.teamleader.eu/oauth2/access_token', params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  return response.data.access_token;
}

// Helper to fetch paginated data (returns all items, not just IDs)
async function fetchAllFull(resource, headers) {
  let hasMore = true;
  let page = 1;
  const limit = 100;
  const allItems = [];

  while (hasMore) {
    const response = await axios.post(`${API_URL}/${resource}.list`, {
      page: { size: limit, number: page },
    }, { headers });

    const data = response.data.data;
    allItems.push(...data);

    hasMore = response.data.has_more;
    page++;
  }

  return allItems;
}

// Helper to fetch customer data by type and id
async function fetchCustomerData(customer, headers) {
  if (!customer || !customer.id || !customer.type) return null;
  const endpoint = customer.type === 'company' ? 'companies.info' : 'contacts.info';
  const response = await axios.post(`${API_URL}/${endpoint}`, { id: customer.id }, { headers });
  return response.data.data;
}

// STEP 2: Handle OAuth2 callback and fetch IDs
app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('No code found in query.');
  }
  try {
    const accessToken = await getAccessTokenFromCode(code);
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
    // Fetch all deals with full data
    const deals = await fetchAllFull('deals', headers);

    // For each deal, fetch and attach customer data
    const dealsWithCustomer = await Promise.all(deals.map(async (deal) => {
      const customer = deal.lead && deal.lead.customer;
      let customer_data = null;
      try {
        customer_data = await fetchCustomerData(customer, headers);
      } catch (e) {
        customer_data = { error: e.response?.data || e.message };
      }
      return { ...deal, customer_data };
    }));

    // Print all deals with their associated customer data
    res.send(`<pre>${JSON.stringify(dealsWithCustomer, null, 2)}</pre>`);
    console.log('All deals with customer data:', dealsWithCustomer);
  } catch (err) {
    res.status(500).send('Error: ' + (err.response ? JSON.stringify(err.response.data) : err.message));
    console.error('Error fetching data:', err.response?.data || err.message);
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
