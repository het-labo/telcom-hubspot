# **🔧 Technische briefing – One-way synchronisatie Teamleader → HubSpot**

## **Script Werking (2025-07-25)**

### **Algemeen**

- **Type synchronisatie**: One-way (Teamleader → HubSpot)
- **Scope**: Contacten, bedrijven en deals
- **Trigger**: Handmatig via script, kan uitgebreid worden naar periodieke sync
- **Logging**: Fouten worden gelogd in de console met referentie naar het record

---

## **Contacten synchronisatie**

- **Matching op e-mailadres**:  
  Het script zoekt in HubSpot naar een contact met hetzelfde primaire e-mailadres als in Teamleader.  
  - **Bestaat contact**: wordt geüpdatet  
  - **Bestaat niet**: wordt aangemaakt  
- **Marketingstatus**:  
  - Contacten <2 jaar geleden gewijzigd: als marketing contact  
  - Contacten tussen 2-5 jaar geleden gewijzigd: als non-marketing contact  
  - Contacten >5 jaar niet gewijzigd: worden niet geïmporteerd  
- **Opt-out**:  
  Opt-out status uit Teamleader wordt meegenomen naar HubSpot.

---

## **Bedrijven synchronisatie**

- **Bedrijf wordt alleen gesynchroniseerd als er een gekoppeld contact is dat ook gesynchroniseerd wordt**
- **Matching op ondernemingsnummer, domeinnaam, of bedrijfsnaam** (volgorde)
- **Relatiebeheer**:  
  Meerdere contacten kunnen aan één bedrijf gekoppeld zijn; deze relatie wordt behouden in HubSpot.

---

## **Deals synchronisatie**

- **Matching op unieke Teamleader deal ID**:  
  Het script gebruikt een custom property `teamleader_id` in HubSpot om deals uniek te identificeren.  
  - **Bestaat deal met deze ID**: wordt geüpdatet  
  - **Bestaat niet**: wordt aangemaakt  
- **Contact-koppeling**:  
  Elke deal wordt gekoppeld aan het juiste contact in HubSpot (op basis van e-mail).
- **Synchronisatieregels**:  
  - Alleen deals met een gekoppeld en gesynchroniseerd contact worden meegenomen  
  - Status en wijzigingsdatum bepalen of en hoe een deal wordt gesynchroniseerd  
  - Deals ouder dan 5 jaar zonder wijziging worden niet gesynchroniseerd  
  - Deals tussen 2-5 jaar oud zonder wijziging krijgen het label ‘inactief’

---

## **Datavelden**

- **Contacten**: voornaam, achternaam, e-mailadres, telefoon, opt-out, jobtitel, taal, etc.
- **Bedrijven**: naam, ondernemingsnummer, domeinnaam, adres, type bedrijf
- **Deals**: status, pipeline, titel, bedrag, gekoppeld contact, gekoppeld bedrijf, creatiedatum, laatst gewijzigd, Teamleader ID

---

## **Logging & foutopvolging**

- Fouten worden direct in de console gelogd met:
  - Timestamp
  - Entiteitstype (contact / bedrijf / deal)
  - Unieke ID (e-mail, ondernemingsnummer, deal ID)
  - Foutboodschap
  - Actie (create / update / skip)

---

## **Extra**

- **Edge cases**: Dubbele e-mails, ontbrekende sleutels, opt-outs zonder e-mail worden afgevangen in de scriptlogica.
- **Custom property**: Zorg dat `teamleader_id` als custom property bestaat in HubSpot voor correcte matching van deals.

---

## **Vervolgstappen**

- Veldmapping bevestigen
- Testen op subset van data
- Edge cases en logging valideren

