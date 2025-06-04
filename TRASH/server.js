require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;

let accessToken = '';

// Teamleader API instance
const teamleader = () =>
  axios.create({
    baseURL: 'https://api.teamleader.eu',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

async function getAllContactsWithDeals() {
    try {
        // 🔹 Fetch only the first page of 100 contacts
        const contactsResponse = await teamleader().post('/contacts.list', {
            page: {
            size: 100,
            number: 1
            }
        });
    
        const contacts = contactsResponse.data.data || [];
        console.log(`Fetched ${contacts.length} contacts`);
    
        // 🔹 Enrich each contact with details + deals
        const contactsWithDetails = await Promise.all(contacts.map(async (contact) => {
          try {
            const contactResponse = await teamleader().post('/contacts.info', {
              id: contact.id
            });
            const contactDetails = contactResponse.data.data;
    
            const dealsResponse = await teamleader().post('/deals.list', {
              filter: {
                customer: {
                  id: contact.id,
                  type: 'contact'
                }
              }
            });
    
            const deals = dealsResponse.data.data || [];
            return { ...contactDetails, deals };
          } catch (error) {
            console.error(`Error for contact ${contact.id}:`, error.message);
            return { ...contact, deals: [] };
          }
    }));

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Teamleader Contacts & Deals</title>
      <style>
        body { font-family: Arial; margin: 20px; }
        .hubspot-button { background: #ff7a59; color: white; padding: 6px 10px; border: none; border-radius: 4px; cursor: pointer; }
        .hubspot-button:hover { background: #ff5a33; }
        .contacts-table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        .contacts-table th, .contacts-table td { border: 1px solid #ddd; padding: 8px; vertical-align: top; }
        .contacts-table th { background-color: #f2f2f2; }
        .deals-table { width: 100%; font-size: 12px; border-collapse: collapse; margin-top: 10px; }
        .deals-table th, .deals-table td { border: 1px solid #ccc; padding: 5px; }
        .status-won { color: green; }
        .status-lost { color: red; }
        .status-open { color: blue; }
      </style>
    </head>
    <body>
      <h2>Teamleader Contacts & Deals</h2>
      <table class="contacts-table">
        <thead>
          <tr><th>Contact Info</th><th>Updated</th></tr>
        </thead>
        <tbody>
          ${contactsWithDetails.map(contact => `
            <tr>
              <td>
                <b>${contact.first_name} ${contact.last_name}</b><br>
                ${contact.emails?.map(e => e.email).join('<br>') || 'No email'}<br>
                ${contact.telephones?.map(p => p.number).join('<br>') || 'No phone'}<br>
                Status: ${
                  contact.deals.some(d => d.status.toLowerCase() === 'won') ? '<span class="status-won">Klant</span>' :
                  contact.deals.some(d => d.status.toLowerCase() === 'lost') ? '<span class="status-lost">Prospect</span>' :
                  '<span class="status-open">Onbekend</span>'
                }
                <br><br>
                <button class="hubspot-button"
                  onclick="syncContactToHubspot(this)"
                  data-email="${contact.emails?.[0]?.email || ''}"
                  data-contact='${JSON.stringify({
                    first_name: contact.first_name,
                    last_name: contact.last_name,
                    email: contact.emails?.[0]?.email || '',
                    status: contact.deals.some(d => d.status.toLowerCase() === 'won') ? 'Klant' :
                            contact.deals.some(d => d.status.toLowerCase() === 'lost') ? 'Prospect' : 'Onbekend',
                    deals: contact.deals.map(deal => ({
                      title: deal.title,
                      status: deal.status,
                      created_at: deal.created_at,
                      amount: deal.estimated_value?.amount || deal.weighted_value?.amount || 0
                    }))
                  })}'
                >Sync to HubSpot</button>

                ${contact.deals.length > 0 ? `
                  <div class="deals-section">
                    <table class="deals-table">
                      <thead><tr><th>Title</th><th>Status</th><th>Value</th><th>Date</th></tr></thead>
                      <tbody>
                        ${contact.deals.map(deal => `
                          <tr>
                            <td>${deal.title}</td>
                            <td>${deal.status}</td>
                            <td>${deal.estimated_value?.amount || deal.weighted_value?.amount || 0}</td>
                            <td>${new Date(deal.created_at).toLocaleDateString()}</td>
                          </tr>
                        `).join('')}
                      </tbody>
                    </table>
                  </div>
                ` : ''}
              </td>
              <td>${new Date(contact.updated_at).toLocaleDateString()}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>

      <script>
        async function syncContactToHubspot(button) {
          const email = button.dataset.email;
          const contactData = JSON.parse(button.dataset.contact);

          if (!email) {
            alert("No email found.");
            return;
          }

          button.disabled = true;
          button.textContent = "Syncing...";

          try {
            const res = await fetch("/hubspot-sync?email=" + encodeURIComponent(email), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(contactData)
            });

            const result = await res.json();
            alert(result.message);
          } catch (err) {
            alert("Error syncing: " + err.message);
          } finally {
            button.disabled = false;
            button.textContent = "Sync to HubSpot";
          }
        }
      </script>
    </body>
    </html>
    `;
    return html;

  } catch (error) {
    console.error('Error:', error.message);
    return 'Error occurred while fetching contacts.';
  }
}

// OAuth flow
function clearAccessToken() {
  accessToken = '';
}

app.get('/', (req, res) => {
  clearAccessToken();
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
      client_secret: CLIENT_SECRET
    });

    accessToken = tokenRes.data.access_token;
    console.log('✅ Access token received');

    const html = await getAllContactsWithDeals();
    res.send(html);
  } catch (err) {
    console.error('OAuth error:', err.message);
    res.status(500).send('OAuth error');
  }
});

// HubSpot sync endpoint
app.post('/hubspot-sync', express.json(), async (req, res) => {
  const { email, first_name, last_name, status, deals = [] } = req.body;

  try {
    const headers = {
      Authorization: `Bearer ${HUBSPOT_TOKEN}`,
      'Content-Type': 'application/json'
    };

    // Check if contact exists
    const searchRes = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/contacts/search',
      {
        filterGroups: [{
          filters: [{ propertyName: 'email', operator: 'EQ', value: email }]
        }]
      },
      { headers }
    );

    let contactId;
    const contactExists = searchRes.data.total > 0;

    if (!contactExists) {
      const createRes = await axios.post(
        'https://api.hubapi.com/crm/v3/objects/contacts',
        {
          properties: {
            email,
            firstname: first_name,
            lastname: last_name,
            contact_status: status
          }
        },
        { headers }
      );
      contactId = createRes.data.id;
    } else {
      contactId = searchRes.data.results[0].id;
    }

    // Create and associate deals
    for (const deal of deals) {
      const dealRes = await axios.post(
        'https://api.hubapi.com/crm/v3/objects/deals',
        {
          properties: {
            dealname: deal.title,
            amount: deal.amount,
            dealstage: mapStatusToHubspotStage(deal.status),
            closedate: new Date(deal.created_at).toISOString()
          }
        },
        { headers }
      );

      const dealId = dealRes.data.id;

      await axios.put(
        `https://api.hubapi.com/crm/v3/objects/deals/${dealId}/associations/contacts/${contactId}/deal_to_contact`,
        {},
        { headers }
      );
    }

    res.json({ message: `✅ Contact synced with ${deals.length} deals.` });
  } catch (err) {
    console.error('HubSpot error:', err.response?.data || err.message);
    res.status(500).json({ message: 'HubSpot sync error' });
  }
});

function mapStatusToHubspotStage(status) {
    switch (status.toLowerCase()) {
        case 'won':
          return 'decisionmakerboughtin';  // 🟢 Replace with your version of "won"
        case 'lost':
          return 'closedlost';             // ✅ Valid stage
        default:
          return 'appointmentscheduled';   // 🔵 For "open" or other states
      }
}

app.listen(3000, () => {
  console.log('🌐 Go to http://localhost:3000 to start');
});
