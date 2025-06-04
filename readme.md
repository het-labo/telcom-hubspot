20250513 API sync Teamleader & HubSpot

Perfect, dank voor de aanvullingen. Op basis van alle input heb ik hieronder een **volledig uitgewerkte technische briefing** opgesteld voor de ontwikkelaar(s) die de **custom API-synchronisatie tussen Teamleader en HubSpot** zullen realiseren. Deze briefing is gestructureerd per onderdeel, met voldoende detaillering om als basis te dienen voor ontwikkeling, testing en eventuele edge case-afhandeling.

---

# **🔧 Technische briefing – One-way synchronisatie Teamleader → HubSpot**

## **1\. Algemene specificaties**

* **Type synchronisatie**: One-way

* **Bron**: Teamleader

* **Doel**: HubSpot

* **Scope**: Contacten, bedrijven en deals

* **Trigger**: Periodieke sync (interval naar keuze), waarbij enkel gewijzigde entiteiten (zie logica hieronder) worden meegenomen.

* **Logging**: Foutmeldingen moeten gelogd worden met duidelijke referentie naar het betrokken record.

---

## **2\. Contacten synchronisatie**

### **🔹 Identificatie & matching**

* **Unieke sleutel in HubSpot**: primair of secundair e-mailadres.

* Als een e-mailadres al bestaat (primair of secundair):

  * **Bestaand contact updaten**

  * **Geen nieuw contact aanmaken**

* E-mailadres altijd behouden uit Teamleader.

### **🔹 Syncregels op basis van wijzigingsdatum**

* **Definitie van ‘gewijzigd’**: Manuele wijziging aan minstens één veld.

* **Recent gewijzigd (\< 2 jaar)**:

  * Importeren als **marketing contact**

* **Gewijzigd tussen 2 en 5 jaar geleden**:

  * Importeren als **non-marketing contact**

* **Niet gewijzigd in 5 jaar of meer**:

  * **Niet importeren**

* Exact 2 of 5 jaar geleden \= **wel importeren**

### **🔹 Opt-out & marketingstatus**

* Enkel contacten zonder opt-out worden gemarkeerd als marketing contact.

* Als een contact een opt-out heeft in Teamleader, moet die info meegenomen worden naar HubSpot.

---

## **3\. Bedrijven synchronisatie**

### **🔹 Voorwaarden**

* Een bedrijf wordt enkel gesynchroniseerd als er minstens één gekoppeld contact is dat ook gesynchroniseerd wordt.

### **🔹 Matchinglogica**

1. **Eerst op ondernemingsnummer**

2. Als ontbrekend: **domeinnaam**

3. Als ontbrekend: **bedrijfsnaam**

### **🔹 Relatiebeheer**

* Meerdere contacten kunnen gelinkt zijn aan één bedrijf – deze relatie moet behouden blijven in HubSpot.

---

## **4\. Deals synchronisatie**

### **🔹 Voorwaarden**

* Alleen deals die een gekoppeld contact hebben (dat ook gesynchroniseerd wordt), mogen gesynchroniseerd worden.

### **🔹 Logica op basis van wijzigingsdatum & status**

* **Gewijzigd \= statuswijziging in de voorbije 2 jaar**

* **Openstaande deals**:

  * **\< 2 jaar geleden gewijzigd** → normaal synchroniseren

  * **Tussen 2 en 5 jaar oud, niet gewijzigd** → synchroniseren met **label ‘inactief’**

  * **Ouder dan 5 jaar én niet gewijzigd** → **niet synchroniseren**

---

## **5\. Datavelden en beperkingen**

### **🔹 Te synchroniseren velden (voorbeeld)**

* Contacten: voornaam, achternaam, e-mailadres, gsm/telefoon, opt-out status, jobtitel, taal, enz.

* Bedrijven: naam, ondernemingsnummer, domeinnaam, adresgegevens, type bedrijf

* Deals: status, pipeline, titel, bedrag, gekoppeld contact, gekoppeld bedrijf, creatiedatum, laatst gewijzigd

### **🔹 Velden die niet mogen overschreven worden in HubSpot**

* **‘Laatste bron’** en **‘Eerste bron’** mogen nooit overschreven worden.

---

## **6\. Synchronisatiefrequentie & updates**

* Dit betreft een **éénmalige import \+ incrementals**:

  * Eerste run: import van alle relevante data conform regels hierboven.

  * Nadien: enkel wijzigingen (in Teamleader) worden opnieuw geïmporteerd.

  * ‘Wijziging’ wordt gedefinieerd als:

    * Aanpassing aan contactgegevens

    * Aanpassing aan dealstatus

    * Nieuwe link tussen contact en deal/bedrijf

---

## **7\. Logging & foutopvolging**

* Alle synchronisatieacties (contacten, bedrijven, deals) moeten gelogd worden.

* **Foutmeldingen** worden opgeslagen in een logbestand of \-service, met:

  * Timestamp

  * Entiteitstype (contact / bedrijf / deal)

  * Unieke ID

  * Foutboodschap

  * Actie (create / update / skip)

* Aanbevolen: visueel dashboard of periodieke foutmelding per e-mail voor monitoring.

---

## **8\. Aanbevolen vervolgstappen voor ontwikkeling**

1. **Bevestig de veldmapping** tussen Teamleader & HubSpot  
2. **Test logica op een subset** (bv. 50 contacten, 10 bedrijven, 10 deals)  
3. **Edge cases afdekken** zoals:  
   * Dubbele e-mails

   * Ontbrekende sleutels (zoals ondernemingsnummer)

   * Opt-outs zonder e-mail

4. **Logging testen** op verschillende fouten en successcenario’s

