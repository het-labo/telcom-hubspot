require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const TARGET_CONTACT_ID = '2021124a-5782-04c6-8865-eb06b79dc813';

let accessToken = '';

const teamleader = () =>
  axios.create({
    baseURL: 'https://api.teamleader.eu',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

async function getContactDeals() {
  try {
    // Get deals for the specific contact using the deals.list endpoint
    const dealsResponse = await teamleader().post('/deals.list', {
      filter: {
        customer: {
          id: TARGET_CONTACT_ID,
          type: 'contact'
        }
      }
    });

    const deals = dealsResponse.data.data || [];
    console.log(`Found ${deals.length} deals for contact ${TARGET_CONTACT_ID}`);

    // Create HTML to display the deals
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Teamleader Focus Deals</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 20px; }
            .container { max-width: 1400px; margin: 0 auto; }
            .refresh-link {
                display: inline-block;
                padding: 10px 20px;
                background-color: #007bff;
                color: white;
                text-decoration: none;
                border-radius: 5px;
                margin-bottom: 20px;
                cursor: pointer;
            }
            .refresh-link:hover {
                background-color: #0056b3;
            }
            .deals-table {
                width: 100%;
                border-collapse: collapse;
                margin-top: 20px;
                font-size: 14px;
            }
            .deals-table th, .deals-table td {
                padding: 12px;
                text-align: left;
                border-bottom: 1px solid #ddd;
                vertical-align: top;
            }
            .deals-table th {
                background-color: #f8f9fa;
                font-weight: bold;
                color: #333;
                position: sticky;
                top: 0;
            }
            .deals-table tr:hover {
                background-color: #f5f5f5;
            }
            .deal-link {
                color: #007bff;
                text-decoration: none;
            }
            .deal-link:hover {
                text-decoration: underline;
            }
            .json-cell {
                white-space: pre-wrap;
                max-width: 300px;
                overflow-x: auto;
            }
            .status-won { color: #28a745; }
            .status-lost { color: #dc3545; }
            .status-open { color: #007bff; }
            .contact-info {
                line-height: 1.4;
                padding: 15px;
                background-color: #f8f9fa;
                border-radius: 4px;
                margin-bottom: 20px;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h2>Teamleader Focus Deals</h2>

            <h3>Deals (${deals.length})</h3>
            ${deals.length > 0 ? `
                <table class="deals-table">
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>Title</th>
                            <th>Status</th>
                            <th>Value</th>
                            <th>Created</th>
                            <th>Updated</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${deals.map(deal => `
                            <tr>
                                <td>${deal.id}</td>
                                <td>
                                    <a href="${deal.web_url}" target="_blank" class="deal-link">${deal.title}</a>
                                </td>
                                <td class="status-${deal.status.toLowerCase()}">${deal.status}</td>
                                <td>${deal.weighted_value?.amount || 'N/A'} | ${deal.estimated_value?.amount || 'N/A'}</td>
                                <td>${new Date(deal.created_at).toLocaleDateString()}</td>
                                <td>${new Date(deal.updated_at).toLocaleDateString()}</td>
                            </tr>
                            <tr>
                                <td colspan="100%">${JSON.stringify(deal, null, 2)}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            ` : '<p>No deals found</p>'}
        </div>
    </body>
    </html>
    `;

    return html;
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    return 'Error occurred while fetching deals data';
  }
}

// Add a function to clear the access token
function clearAccessToken() {
  accessToken = '';
  console.log('Access token cleared');
}

// Add a new endpoint to clear the token
app.post('/clear-token', (req, res) => {
  clearAccessToken();
  res.sendStatus(200);
});

// Modify the root endpoint to ensure it always starts a new OAuth flow
app.get('/', (req, res) => {
  // Clear any existing token
  clearAccessToken();
  
  const url = `https://focus.teamleader.eu/oauth2/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=deals`;
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
    console.log('✅ Got access token');
    
    // Get deals for the specific contact
    const html = await getContactDeals();
    res.send(html);
  } catch (error) {
    console.error('Error getting access token:', error.response?.data || error.message);
    res.status(500).send('Error getting access token. Check the console for details.');
  }
});

// Add a new endpoint for refreshing data
app.get('/refresh', async (req, res) => {
  try {
    // Clear the token to force a new OAuth flow
    clearAccessToken();
    
    // Redirect to the OAuth flow
    const url = `https://focus.teamleader.eu/oauth2/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=deals`;
    res.redirect(url);
  } catch (error) {
    console.error('Error refreshing data:', error);
    res.status(500).send('Error refreshing data. Check the console for details.');
  }
});

app.listen(3000, () => {
  console.log('🌐 Go to http://localhost:3000 to start the OAuth flow');
});
