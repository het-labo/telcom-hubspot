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
let autoSyncActive = false;
let lastContactId = null; // Add this at the top-level (global)
let syncJobActive = false;

// Helper: flatten all emails (primary + secondary)
function getAllEmails(contact) {
  const emails = [];
  if (Array.isArray(contact.emails)) {
    for (const e of contact.emails) {
      if (e.email) emails.push(e.email.toLowerCase());
    }
  }
  return emails;
}

// Helper: check opt-out
function hasOptOut(contact) {
  return !!contact.opt_out;
}

async function backgroundSyncAllContacts() {
  if (syncJobActive) return;
  syncJobActive = true;
  let startingAfter = null;
  let page = 1;
  while (true) {
    console.log(`🔄 Syncing page ${page}...`);
    try {
      const nextCursor = await syncContactsPage(startingAfter);
      if (!nextCursor) {
        console.log('✅ All contacts synced.');
        break;
      }
      startingAfter = nextCursor;
      page++;
      await new Promise(resolve => setTimeout(resolve, 30000)); // 30 seconds
    } catch (err) {
      console.error('❌ Error in auto sync:', err);
      break;
    }
  }
  syncJobActive = false;
}

// Aantal te synchroniseren records beperken (voor testing)
const SYNC_LIMIT = 20;

app.use(express.json());

const teamleader = () =>
  axios.create({
    baseURL: 'https://api.teamleader.eu',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    timeout: 60000 // 60 seconds
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

// Improved: also sync if changed exactly 2 or 5 years ago
function getSyncTypeByDate(updated_at) {
  const diffYears = (Date.now() - new Date(updated_at)) / (1000 * 60 * 60 * 24 * 365);
  if (diffYears < 2 || Math.abs(diffYears - 2) < 0.01) return 'marketing';
  if (diffYears < 5 || Math.abs(diffYears - 5) < 0.01) return 'non-marketing';
  return 'skip';
}

async function getRecentContacts(limit = SYNC_LIMIT, startingAfter = null) {
  const body = { page: { size: limit } };
  if (startingAfter) body.page.starting_after = startingAfter;
  const response = await teamleader().post('/contacts.list', body);
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

// Improved: Search HubSpot contact by all emails (primary + secondary)
async function searchHubspotContact(emails) {
  if (!emails || emails.length === 0) return null;
  const filterGroup = {
    filters: emails.map(email => ({
      propertyName: 'email',
      operator: 'EQ',
      value: email
    }))
  };
  const res = await axios.post(
    'https://api.hubapi.com/crm/v3/objects/contacts/search',
    { filterGroups: [filterGroup] },
    { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
  );
  return res.data.total > 0 ? res.data.results[0] : null;
}

// Improved: Exclude forbidden fields, handle opt-out, marketing status, and edge cases
async function createOrUpdateHubspotContact(contact, deals) {
  const emails = getAllEmails(contact);
  const email = emails[0];
  if (!email) return logSyncAction({ type: 'contact', id: contact.id, action: 'skip', message: 'No email' });

  // Check for duplicate emails in Teamleader (edge case)
  if (emails.length !== new Set(emails).size) {
    logSyncAction({ type: 'contact', id: contact.id, action: 'skip', message: 'Duplicate emails in Teamleader' });
    return;
  }

  const existing = await searchHubspotContact(emails);

  // Determine sync type by date
  const syncType = getSyncTypeByDate(contact.updated_at);
  if (syncType === 'skip') return logSyncAction({ type: 'contact', id: contact.id, action: 'skip', message: '>5y old or not changed' });

  const companyName = contact.company?.name || '';

  // Opt-out logic
  const optOut = hasOptOut(contact);

  // Marketing status logic
  let hs_marketable_status = undefined;
  if (!optOut) {
    hs_marketable_status = syncType === 'marketing' ? 'MARKETING' : 'NON_MARKETING';
  } else {
    hs_marketable_status = 'NON_MARKETING';
  }

  // Prepare properties, exclude forbidden fields
  const props = {
    email,
    firstname: contact.first_name,
    lastname: contact.last_name,
    phone: contact.telephones?.[0]?.number || '',
    jobtitle: contact.job_title || '',
    hs_language: contact.language || '',
    company: companyName,
    ...(typeof hs_marketable_status !== 'undefined' && { hs_marketable_status }),
    ...(optOut && { hs_email_optout: true })
  };
  // Never overwrite 'Laatste bron' and 'Eerste bron'
  delete props['laatste_bron'];
  delete props['eerste_bron'];

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

// Improved: Only sync deals with a synced contact, apply status/label logic
async function syncDeals(deals, contactId) {
  for (const deal of deals) {
    // Only sync deals with a contact that is also synced (already ensured by caller)
    const updatedYears = (Date.now() - new Date(deal.updated_at)) / (1000 * 60 * 60 * 24 * 365);

    // Determine deal_status according to your rules
    let dealStatus = '';
    if (updatedYears < 2 || Math.abs(updatedYears - 2) < 0.01) {
      dealStatus = 'actief (<2 jaar)';
    } else if ((updatedYears >= 2 && updatedYears < 5) || Math.abs(updatedYears - 5) < 0.01) {
      dealStatus = 'inactief (2-5 jaar)';
    } else {
      logSyncAction({ type: 'deal', id: deal.id, action: 'skip', message: 'Deal >5y old' });
      continue; // Skip deals older than 5 years
    }

    // Only sync if status changed in last 2 years or is inactief (2-5y)
    if (dealStatus === 'actief (<2 jaar)' || dealStatus === 'inactief (2-5 jaar)') {
      const props = {
        dealname: deal.title || 'No title',
        amount: deal.estimated_value?.amount || 0,
        dealstage: mapStatusToHubspotStage(deal.status),
        closedate: new Date(deal.created_at).toISOString(),
        deal_status: dealStatus
      };

      // Never overwrite 'Laatste bron' and 'Eerste bron'
      delete props['laatste_bron'];
      delete props['eerste_bron'];

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
}

async function getCompanyDetails(companyId) {
  const res = await teamleader().post('/companies.info', { id: companyId });
  return res.data.data;
}

// Improved: Robust fallback order and logging for missing keys
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
      logSyncAction({ type: 'company', id: company.id, action: 'error', message: `Error searching company by ${attempt.property}`, error: err.response?.data || err.message });
    }
  }
  logSyncAction({ type: 'company', id: company.id, action: 'skip', message: 'No matching key (VAT/domain/name) found for company in HubSpot' });
  return null;
}

// Improved: Only sync company if at least one linked contact is synced
async function createOrUpdateHubspotCompany(company, linkedContactIds = []) {
  if (!linkedContactIds.length) {
    logSyncAction({ type: 'company', id: company.id, action: 'skip', message: 'No synced contacts linked to company' });
    return;
  }
  logSyncAction({ type: 'company', id: company.id, action: 'info', message: `Preparing sync for company: ${company.name} | VAT: ${company.vat_number || 'n/a'} | Website: ${company.website || 'n/a'}` });
  const props = {
    name: company.name,
    vat_number: company.vat_number || '',
    domain: company.website || '',
    city: company.address?.locality || '',
    address: company.address?.line_1 || '',
    country: company.address?.country || ''
  };
  // Never overwrite 'Laatste bron' and 'Eerste bron'
  delete props['laatste_bron'];
  delete props['eerste_bron'];

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

// Improved: Track and sync new associations (contact-company, contact-deal)
async function syncContactsPage(startingAfter = null) {
  const contacts = await getRecentContacts(SYNC_LIMIT, startingAfter);
  if (!contacts.length) return null; // No more contacts

  const syncedContacts = [];
  const companyMap = new Map();

  for (const contact of contacts) {
    const full = await getContactDetails(contact.id);
    logSyncAction({
      type: 'company',
      id: full.company?.id || '-',
      action: full.company?.id ? 'contact-company-detected' : 'no-company',
      message: full.company?.id ? `Contact ${full.id} is linked to company ID ${full.company.id}` : `Contact ${full.id} has no company`
    });

    // Only sync if changed in last 5 years (or exactly 2/5 years)
    const syncType = getSyncTypeByDate(full.updated_at);
    if (syncType === 'skip') {
      logSyncAction({ type: 'contact', id: full.id, action: 'skip', message: 'Not recently updated' });
      continue;
    }

    // Edge case: opt-out without email
    if (hasOptOut(full) && (!full.emails || full.emails.length === 0)) {
      logSyncAction({ type: 'contact', id: full.id, action: 'skip', message: 'Opt-out but no email' });
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

  // Only sync companies with at least one synced contact
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

  // Return the last contact's ID for the next page
  return contacts[contacts.length - 1].id;
}

async function autoSyncAllContacts() {
  if (autoSyncActive) return;
  autoSyncActive = true;
  let startingAfter = null;
  let page = 1;
  while (true) {
    console.log(`🔄 Syncing page ${page}...`);
    try {
      const nextCursor = await syncContactsPage(startingAfter);
      if (!nextCursor) {
        console.log('✅ All contacts synced.');
        break;
      }
      startingAfter = nextCursor;
      page++;
      await new Promise(resolve => setTimeout(resolve, 30000)); // 30 seconds
    } catch (err) {
      console.error('❌ Error in auto sync:', err);
      break;
    }
  }
  autoSyncActive = false;
}

app.post('/sync', async (req, res) => {
  if (!accessToken) {
    return res.status(401).send('❌ Access token ontbreekt. Ga eerst naar / om in te loggen bij Teamleader.');
  }
  if (!syncJobActive) {
    backgroundSyncAllContacts();
  }
  res.send(`
    <html>
      <head><title>Sync gestart</title></head>
      <body style="font-family:sans-serif; padding:20px;">
        <h2>⏳ Sync gestart!</h2>
        <p>De synchronisatie draait nu op de achtergrond.<br>
        Je kunt deze pagina sluiten of later de log bekijken in <code>sync-log.jsonl</code>.</p>
        <form action="/interface" method="GET">
          <button type="submit" style="padding:10px 20px; font-size:16px;">Terug naar interface</button>
        </form>
      </body>
    </html>
  `);
});

// Add a route to check sync status (for AJAX polling)
app.get('/sync-status', (req, res) => {
  res.json({ syncing: syncJobActive });
});

// Eenvoudige webinterface
app.get('/interface', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Teamleader → HubSpot Sync</title>
        <style>
          #sync-indicator {
            display: none;
            margin-top: 20px;
            font-size: 18px;
            color: #0077c2;
          }
          .dot {
            animation: blink 1s infinite;
          }
          .dot:nth-child(2) { animation-delay: 0.2s; }
          .dot:nth-child(3) { animation-delay: 0.4s; }
          @keyframes blink {
            0%, 80%, 100% { opacity: 0.2; }
            40% { opacity: 1; }
          }
        </style>
      </head>
      <body style="font-family:sans-serif; padding:20px;">
        <h2>Teamleader → HubSpot Sync Interface</h2>
        <form id="sync-form" action="/sync" method="POST">
          <input type="hidden" name="starting_after" value="">
          <button type="submit" style="padding:10px 20px; font-size:16px;">Start Sync (First 20)</button>
        </form>
        <div id="sync-indicator">
          <span>Synchroniseren</span>
          <span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>
        </div>
        <script>
          function checkSyncStatus() {
            fetch('/sync-status')
              .then(res => res.json())
              .then(data => {
                const indicator = document.getElementById('sync-indicator');
                if (data.syncing) {
                  indicator.style.display = 'inline-block';
                  setTimeout(checkSyncStatus, 1000);
                } else {
                  indicator.style.display = 'none';
                }
              });
          }
          // Show indicator on form submit and start polling
          document.getElementById('sync-form').addEventListener('submit', function() {
            document.getElementById('sync-indicator').style.display = 'inline-block';
            setTimeout(checkSyncStatus, 1000);
          });
          // Also check on page load in case sync is already running
          window.onload = checkSyncStatus;
        </script>
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

app.get('/start-auto-sync', async (req, res) => {
  if (!accessToken) {
    return res.status(401).send('❌ Access token ontbreekt. Log eerst in bij Teamleader.');
  }
  autoSyncAllContacts();
  res.send('⏳ Automatic sync started in background.');
});

app.listen(3000, () => {
  console.log('🚀 Server running on http://localhost:3000');
});
