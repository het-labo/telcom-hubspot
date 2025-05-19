require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

let accessToken = '';

const teamleader = () =>
  axios.create({
    baseURL: 'https://api.teamleader.eu',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

async function getAllContacts() {
  try {
    // Get contacts using the contacts.list endpoint
    const contactsResponse = await teamleader().post('/contacts.list', {
      page: {
        size: 100,  // Get 100 contacts per page
        number: 1
      }
    });

    const contacts = contactsResponse.data.data || [];
    console.log(`Found ${contacts.length} contacts`);

    // Process each contact to get detailed information
    const contactsWithDetails = await Promise.all(contacts.map(async (contact) => {
      try {
        const contactResponse = await teamleader().post('/contacts.info', {
          id: contact.id
        });
        return contactResponse.data.data;
      } catch (error) {
        console.error(`Error fetching contact info for ID ${contact.id}:`, error.message);
        return contact;
      }
    }));

    // Create HTML to display the contacts
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Teamleader Focus Contacts</title>
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
            .contacts-table {
                width: 100%;
                border-collapse: collapse;
                margin-top: 20px;
                font-size: 14px;
            }
            .contacts-table th, .contacts-table td {
                padding: 12px;
                text-align: left;
                border-bottom: 1px solid #ddd;
                vertical-align: top;
            }
            .contacts-table th {
                background-color: #f8f9fa;
                font-weight: bold;
                color: #333;
                position: sticky;
                top: 0;
            }
            .contacts-table tr:hover {
                background-color: #f5f5f5;
            }
            .contact-link {
                color: #007bff;
                text-decoration: none;
            }
            .contact-link:hover {
                text-decoration: underline;
            }
            .json-cell {
                white-space: pre-wrap;
                max-width: 300px;
                overflow-x: auto;
            }
            .contact-info {
                line-height: 1.4;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h2>Teamleader Focus Contacts</h2>
            <div>
                <a href="/refresh" class="refresh-link">Refresh Contacts</a>
            </div>
            
            <h3>Contacts (${contacts.length})</h3>
            ${contacts.length > 0 ? `
                <table class="contacts-table">
                    <thead>
                        <tr>
                            <th>Contact</th>
                            <th>Created</th>
                            <th>Updated</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${contactsWithDetails.map(contact => `
                            <tr>
                                <td>
                                    <div>${contact.id}</div>
                                    <a href="${contact.web_url}" target="_blank" class="contact-link">${contact.first_name} ${contact.last_name}</a>
                                    <div>${contact.emails?.map(email => `${email.email} (${email.type})`).join('<br>') || 'N/A'}</div>
                                    <div>${contact.telephones?.map(phone => `${phone.number} (${phone.type})`).join('<br>') || 'N/A'}</div>
                                    <div></div>
                                </td>
                                <td>${new Date(contact.created_at).toLocaleDateString()}</td>
                                <td>${new Date(contact.updated_at).toLocaleDateString()}</td>
                            </tr>
                            <tr style="display: none;">
                                <td colspan="100%">${JSON.stringify(contact, null, 2)}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            ` : '<p>No contacts found</p>'}
        </div>
    </body>
    </html>
    `;

    return html;
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    return 'Error occurred while fetching contacts data';
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
  
  const url = `https://focus.teamleader.eu/oauth2/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=contacts`;
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
    
    // Get all contacts
    const html = await getAllContacts();
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
    const url = `https://focus.teamleader.eu/oauth2/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=contacts`;
    res.redirect(url);
  } catch (error) {
    console.error('Error refreshing data:', error);
    res.status(500).send('Error refreshing data. Check the console for details.');
  }
});

app.listen(3000, () => {
  console.log('🌐 Go to http://localhost:3000 to start the OAuth flow');
});
