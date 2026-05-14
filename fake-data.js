// APC Beta — fake data generator for test properties
// All data here is FAKE. For UX testing only.

(function () {
  const TOWNS = [
    "Faro","Tavira","Lagos","Portimão","Albufeira","Loulé","Olhão",
    "Sagres","Carvoeiro","Silves","Vilamoura","Quarteira","Aljezur",
    "Monchique","Castro Marim"
  ];

  const STREET_PREFIXES = ["Rua","Avenida","Travessa","Largo","Praceta","Estrada"];
  const STREET_NAMES = [
    "do Mar","da Liberdade","das Flores","do Sol","da Praia","dos Pescadores",
    "Vasco da Gama","do Comércio","de São João","da Igreja","do Castelo",
    "dos Descobrimentos","da Ribeira","do Pinhal","das Oliveiras"
  ];

  const PROPERTY_TYPES = [
    "Detached villa","Semi-detached villa","Townhouse",
    "Apartment","Penthouse","Cottage","Country house"
  ];

  function rand(n) { return Math.floor(Math.random() * n); }
  function pick(arr) { return arr[rand(arr.length)]; }
  function pad(n, w) { return String(n).padStart(w, "0"); }

  function fakePostcode() {
    // Portuguese postcode: NNNN-NNN
    return pad(8000 + rand(1000), 4) + "-" + pad(rand(1000), 3);
  }

  function fakeAddress(town) {
    const num = 1 + rand(250);
    return `${pick(STREET_PREFIXES)} ${pick(STREET_NAMES)}, ${num}, ${town}`;
  }

  function fakeNIF() {
    // 9 digits, starts with 1,2,5,6,8,9
    const first = pick(["1","2","5","6","8","9"]);
    let rest = "";
    for (let i = 0; i < 8; i++) rest += String(rand(10));
    return first + rest;
  }

  function fakeALLicence() {
    // Format like NNNNN/AL
    return pad(10000 + rand(89999), 5) + "/AL";
  }

  function fakeYearBuilt() {
    return 1960 + rand(64); // 1960 — 2023
  }

  function fakeComplianceScore() {
    // Weighted to mid-range so the journey feels realistic
    const base = 55 + rand(40); // 55–94
    return base;
  }

  function fakeDocFlags() {
    // Each doc has random present/missing status
    const docs = [
      { key: "caderneta",    label: "Caderneta Predial (Tax record)" },
      { key: "licenca_uso",  label: "Licença de Utilização (Habitation licence)" },
      { key: "id_owner",     label: "Owner ID / Passport" },
      { key: "nif_proof",    label: "NIF proof" },
      { key: "energy_cert",  label: "Energy certificate" },
      { key: "insurance",    label: "Property insurance" },
      { key: "floor_plan",   label: "Floor plan" },
      { key: "iban_proof",   label: "IBAN proof (for tourism tax)" }
    ];
    return docs.map(d => ({
      ...d,
      present: Math.random() > 0.35   // ~65% present
    }));
  }

  window.APC_FAKE = {
    TOWNS,
    generate(realTown) {
      const town = realTown && TOWNS.includes(realTown) ? realTown : pick(TOWNS);
      const bedrooms = 1 + rand(5);          // 1–5
      const capacity = bedrooms * 2 + rand(3); // 2–13
      return {
        town,
        address: fakeAddress(town),
        postcode: fakePostcode(),
        property_type: pick(PROPERTY_TYPES),
        bedrooms,
        capacity,
        year_built: fakeYearBuilt(),
        nif: fakeNIF(),
        al_licence: fakeALLicence(),
        compliance_score: fakeComplianceScore(),
        doc_flags: fakeDocFlags()
      };
    }
  };
})();
