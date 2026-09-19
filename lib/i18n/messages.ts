import type { Locale } from "./config";

const en = {
  language: "Language",
  login: "Log in",
  signup: "Sign up",
  trips: "My trips",
  account: "Account",
  logout: "Log out",
  savedStays: "Saved stays",
  hostWorkspace: "Host workspace",
  listProperty: "Become a HOST",
  dashboard: "Dashboard",
  bookings: "Bookings",
  properties: "Properties",
  reviews: "Reviews",
  eyebrow: "Premium European city stays",
  heroLead: "Considered stays in Europe's",
  heroEmphasis: "most storied",
  heroEnd: "cities.",
  heroBody:
    "HOST connects discerning guests with exceptional independent accommodation across Europe — from riverside Lisbon apartments to quiet Copenhagen courtyards. Every stay, carefully chosen.",
  destination: "Destination",
  checkin: "Check-in",
  checkout: "Check-out",
  guests: "Guests",
  search: "Search stays",
  browse: "Browse destinations",
  where: "Where to stay",
  firstLook:
    "A first look at HOST's European cities",
  mapEyebrow: "Explore HOST",

  mapHeading: "Stay close to the cities you came to experience",

  mapPrivacy: "Markers show approximate areas only. Select a property marker to view the stay.",

  mapLoading: "Loading property locations…",

  conciergeButton: "Ask HOST",

  conciergeTitle: "HOST concierge",

  conciergeWelcome: "Tell me what kind of city stay you are looking for.",

  conciergePlaceholder: "A quiet city stay for two…",

  conciergeSend: "Ask",

  conciergeThinking: "Finding suitable stays…",

  conciergeError: "The concierge is temporarily unavailable. Please try again.",

  conciergeDisclaimer: "AI recommendations use published listing details. Confirm live availability and final pricing before booking. Do not share personal or payment information.",

  conciergeClose: "Close concierge",

  conciergeViewStay: "View stay",

  conciergePerNight: "per night",

  conciergeSuggestions: "You could also ask",


  contact: "Contact HOST",


  conciergeContact: "Need more help? Contact HOST",

  checkoutMissing: "Add a check-out date.",
  checkinMissing: "Add a check-in date.",
  datesInvalid:
    "Check-out must be after check-in.",
  guestInvalid:
    "At least 1 guest is required.",
};

export type MessageKey = keyof typeof en;

type Dictionary = Record<MessageKey, string>;

export const messages: Record<
  Locale,
  Dictionary
> = {
  en,

  de: {
    language: "Sprache",
    login: "Anmelden",
    signup: "Registrieren",
    trips: "Meine Reisen",
    account: "Konto",
    logout: "Abmelden",
    savedStays: "Gespeicherte Unterkünfte",
    hostWorkspace: "Gastgeberbereich",
    listProperty: "HOST-Gastgeber werden",
    dashboard: "Übersicht",
    bookings: "Buchungen",
    properties: "Unterkünfte",
    reviews: "Bewertungen",
    eyebrow:
      "Erstklassige Städtereisen in Europa",
    heroLead:
      "Ausgewählte Aufenthalte in Europas",
    heroEmphasis: "geschichtsträchtigsten",
    heroEnd: "Städten.",
    heroBody:
      "HOST verbindet anspruchsvolle Gäste mit außergewöhnlichen unabhängigen Unterkünften in ganz Europa — von Apartments am Fluss in Lissabon bis zu ruhigen Innenhöfen in Kopenhagen. Jeder Aufenthalt sorgfältig ausgewählt.",
    destination: "Reiseziel",
    checkin: "Anreise",
    checkout: "Abreise",
    guests: "Gäste",
    search: "Unterkünfte suchen",
    browse: "Reiseziele entdecken",
    where: "Wohin reisen?",
    firstLook:
      "Ein erster Blick auf die europäischen Städte von HOST",
    mapEyebrow: "HOST entdecken",

    mapHeading: "Übernachten Sie nah an den Städten, die Sie erleben möchten",

    mapPrivacy: "Die Markierungen zeigen nur ungefähre Gebiete. Wählen Sie eine Unterkunft aus, um sie anzusehen.",

    mapLoading: "Unterkunftsstandorte werden geladen…",

    conciergeButton: "HOST fragen",

    conciergeTitle: "HOST-Concierge",

    conciergeWelcome: "Beschreiben Sie, welche Art von Städtereise Sie suchen.",

    conciergePlaceholder: "Ein ruhiger Städteaufenthalt für zwei…",

    conciergeSend: "Fragen",

    conciergeThinking: "Passende Unterkünfte werden gesucht…",

    conciergeError: "Der Concierge ist vorübergehend nicht verfügbar. Bitte versuchen Sie es erneut.",

    conciergeDisclaimer: "KI-Empfehlungen basieren auf veröffentlichten Unterkunftsangaben. Prüfen Sie Verfügbarkeit und Endpreis. Teilen Sie keine persönlichen Daten oder Zahlungsinformationen.",

    conciergeClose: "Concierge schließen",

    conciergeViewStay: "Unterkunft ansehen",

    conciergePerNight: "pro Nacht",

    conciergeSuggestions: "Sie könnten auch fragen",


    contact: "HOST kontaktieren",


    conciergeContact: "Weitere Hilfe? HOST kontaktieren",

    checkoutMissing:
      "Fügen Sie ein Abreisedatum hinzu.",
    checkinMissing:
      "Fügen Sie ein Anreisedatum hinzu.",
    datesInvalid:
      "Die Abreise muss nach der Anreise liegen.",
    guestInvalid:
      "Mindestens 1 Gast ist erforderlich.",
  },

  fr: {
    language: "Langue",
    login: "Connexion",
    signup: "S’inscrire",
    trips: "Mes voyages",
    account: "Compte",
    logout: "Déconnexion",
    savedStays: "Hébergements enregistrés",
    hostWorkspace: "Espace hôte",
    listProperty: "Devenir hôte HOST",
    dashboard: "Tableau de bord",
    bookings: "Réservations",
    properties: "Hébergements",
    reviews: "Avis",
    eyebrow:
      "Séjours haut de gamme dans les villes européennes",
    heroLead:
      "Des séjours choisis dans les villes",
    heroEmphasis:
      "les plus chargées d’histoire",
    heroEnd: "d’Europe.",
    heroBody:
      "HOST met en relation des voyageurs exigeants avec des hébergements indépendants d’exception partout en Europe — des appartements au bord du Tage à Lisbonne aux cours paisibles de Copenhague. Chaque séjour est choisi avec soin.",
    destination: "Destination",
    checkin: "Arrivée",
    checkout: "Départ",
    guests: "Voyageurs",
    search: "Rechercher",
    browse: "Découvrir les destinations",
    where: "Où séjourner",
    firstLook:
      "Un premier aperçu des villes européennes de HOST",
    mapEyebrow: "Découvrir HOST",

    mapHeading: "Séjournez au cœur des villes que vous souhaitez découvrir",

    mapPrivacy: "Les marqueurs indiquent uniquement des zones approximatives. Sélectionnez un hébergement pour le consulter.",

    mapLoading: "Chargement des emplacements…",

    conciergeButton: "Demander à HOST",

    conciergeTitle: "Concierge HOST",

    conciergeWelcome: "Décrivez le type de séjour urbain que vous recherchez.",

    conciergePlaceholder: "Un séjour paisible en ville pour deux…",

    conciergeSend: "Demander",

    conciergeThinking: "Recherche d’hébergements adaptés…",

    conciergeError: "Le concierge est temporairement indisponible. Veuillez réessayer.",

    conciergeDisclaimer: "Les recommandations de l’IA utilisent les informations publiées. Vérifiez les disponibilités et le prix final. Ne partagez aucune donnée personnelle ou de paiement.",

    conciergeClose: "Fermer le concierge",

    conciergeViewStay: "Voir l’hébergement",

    conciergePerNight: "par nuit",

    conciergeSuggestions: "Vous pourriez aussi demander",


    contact: "Contacter HOST",


    conciergeContact: "Besoin d'aide ? Contacter HOST",

    checkoutMissing:
      "Ajoutez une date de départ.",
    checkinMissing:
      "Ajoutez une date d’arrivée.",
    datesInvalid:
      "Le départ doit être postérieur à l’arrivée.",
    guestInvalid:
      "Au moins 1 voyageur est requis.",
  },

  es: {
    language: "Idioma",
    login: "Iniciar sesión",
    signup: "Registrarse",
    trips: "Mis viajes",
    account: "Cuenta",
    logout: "Cerrar sesión",
    savedStays: "Alojamientos guardados",
    hostWorkspace: "Espacio de anfitrión",
    listProperty: "Conviértete en anfitrión HOST",
    dashboard: "Panel",
    bookings: "Reservas",
    properties: "Alojamientos",
    reviews: "Reseñas",
    eyebrow:
      "Estancias premium en ciudades europeas",
    heroLead:
      "Estancias selectas en las ciudades",
    heroEmphasis: "con más historia",
    heroEnd: "de Europa.",
    heroBody:
      "HOST conecta a huéspedes exigentes con alojamientos independientes excepcionales en toda Europa: desde apartamentos junto al río en Lisboa hasta tranquilos patios en Copenhague. Cada estancia, elegida con cuidado.",
    destination: "Destino",
    checkin: "Llegada",
    checkout: "Salida",
    guests: "Huéspedes",
    search: "Buscar estancias",
    browse: "Explorar destinos",
    where: "Dónde alojarse",
    firstLook:
      "Un primer vistazo a las ciudades europeas de HOST",
    mapEyebrow: "Explora HOST",

    mapHeading: "Alójate cerca de las ciudades que has venido a descubrir",

    mapPrivacy: "Los marcadores muestran solo zonas aproximadas. Selecciona un alojamiento para verlo.",

    mapLoading: "Cargando ubicaciones…",

    conciergeButton: "Preguntar a HOST",

    conciergeTitle: "Conserje HOST",

    conciergeWelcome: "Cuéntanos qué tipo de estancia urbana buscas.",

    conciergePlaceholder: "Una estancia tranquila para dos…",

    conciergeSend: "Preguntar",

    conciergeThinking: "Buscando alojamientos adecuados…",

    conciergeError: "El conserje no está disponible temporalmente. Inténtalo de nuevo.",

    conciergeDisclaimer: "Las recomendaciones de IA usan datos publicados. Confirma la disponibilidad y el precio final. No compartas datos personales ni de pago.",

    conciergeClose: "Cerrar el conserje",

    conciergeViewStay: "Ver alojamiento",

    conciergePerNight: "por noche",

    conciergeSuggestions: "También puedes preguntar",


    contact: "Contactar con HOST",


    conciergeContact: "Necesitas ayuda? Contacta con HOST",

    checkoutMissing:
      "Añade una fecha de salida.",
    checkinMissing:
      "Añade una fecha de llegada.",
    datesInvalid:
      "La salida debe ser posterior a la llegada.",
    guestInvalid:
      "Se requiere al menos 1 huésped.",
  },

  it: {
    language: "Lingua",
    login: "Accedi",
    signup: "Registrati",
    trips: "I miei viaggi",
    account: "Account",
    logout: "Esci",
    savedStays: "Soggiorni salvati",
    hostWorkspace: "Area host",
    listProperty: "Diventa host su HOST",
    dashboard: "Dashboard",
    bookings: "Prenotazioni",
    properties: "Alloggi",
    reviews: "Recensioni",
    eyebrow:
      "Soggiorni premium nelle città europee",
    heroLead:
      "Soggiorni selezionati nelle città",
    heroEmphasis: "più ricche di storia",
    heroEnd: "d’Europa.",
    heroBody:
      "HOST mette in contatto ospiti esigenti con eccezionali alloggi indipendenti in tutta Europa: dagli appartamenti sul fiume a Lisbona ai tranquilli cortili di Copenaghen. Ogni soggiorno è scelto con cura.",
    destination: "Destinazione",
    checkin: "Check-in",
    checkout: "Check-out",
    guests: "Ospiti",
    search: "Cerca soggiorni",
    browse: "Esplora destinazioni",
    where: "Dove soggiornare",
    firstLook:
      "Un primo sguardo alle città europee di HOST",
    mapEyebrow: "Scopri HOST",

    mapHeading: "Soggiorna vicino alle città che desideri vivere",

    mapPrivacy: "I marcatori mostrano solo aree approssimative. Seleziona un alloggio per visualizzarlo.",

    mapLoading: "Caricamento delle posizioni…",

    conciergeButton: "Chiedi a HOST",

    conciergeTitle: "Concierge HOST",

    conciergeWelcome: "Descrivi il tipo di soggiorno in città che stai cercando.",

    conciergePlaceholder: "Un soggiorno tranquillo per due…",

    conciergeSend: "Chiedi",

    conciergeThinking: "Ricerca degli alloggi adatti…",

    conciergeError: "Il concierge non è temporaneamente disponibile. Riprova.",

    conciergeDisclaimer: "I consigli dell’IA utilizzano dati pubblicati. Verifica disponibilità e prezzo finale. Non condividere dati personali o di pagamento.",

    conciergeClose: "Chiudi il concierge",

    conciergeViewStay: "Vedi alloggio",

    conciergePerNight: "a notte",

    conciergeSuggestions: "Potresti anche chiedere",


    contact: "Contatta HOST",


    conciergeContact: "Serve altro aiuto? Contatta HOST",

    checkoutMissing:
      "Aggiungi una data di check-out.",
    checkinMissing:
      "Aggiungi una data di check-in.",
    datesInvalid:
      "Il check-out deve essere successivo al check-in.",
    guestInvalid:
      "È richiesto almeno 1 ospite.",
  },

  nl: {
    language: "Taal",
    login: "Inloggen",
    signup: "Registreren",
    trips: "Mijn reizen",
    account: "Account",
    logout: "Uitloggen",
    savedStays: "Opgeslagen verblijven",
    hostWorkspace: "Hostomgeving",
    listProperty: "Word HOST-host",
    dashboard: "Dashboard",
    bookings: "Boekingen",
    properties: "Accommodaties",
    reviews: "Beoordelingen",
    eyebrow:
      "Hoogwaardige verblijven in Europese steden",
    heroLead:
      "Zorgvuldig gekozen verblijven in Europa's",
    heroEmphasis: "meest historische",
    heroEnd: "steden.",
    heroBody:
      "HOST brengt veeleisende gasten samen met uitzonderlijke onafhankelijke accommodaties in heel Europa — van appartementen aan de rivier in Lissabon tot rustige binnenplaatsen in Kopenhagen. Elk verblijf zorgvuldig gekozen.",
    destination: "Bestemming",
    checkin: "Inchecken",
    checkout: "Uitchecken",
    guests: "Gasten",
    search: "Verblijven zoeken",
    browse: "Bestemmingen bekijken",
    where: "Waar verblijven",
    firstLook:
      "Een eerste blik op de Europese steden van HOST",
    mapEyebrow: "Ontdek HOST",

    mapHeading: "Verblijf dicht bij de steden die je wilt beleven",

    mapPrivacy: "Markeringen tonen alleen globale gebieden. Selecteer een accommodatie om deze te bekijken.",

    mapLoading: "Locaties van accommodaties laden…",

    conciergeButton: "Vraag HOST",

    conciergeTitle: "HOST-conciërge",

    conciergeWelcome: "Vertel ons wat voor stedelijk verblijf je zoekt.",

    conciergePlaceholder: "Een rustig verblijf voor twee…",

    conciergeSend: "Vraag",

    conciergeThinking: "Geschikte accommodaties zoeken…",

    conciergeError: "De conciërge is tijdelijk niet beschikbaar. Probeer het opnieuw.",

    conciergeDisclaimer: "AI-aanbevelingen gebruiken gepubliceerde informatie. Controleer beschikbaarheid en de definitieve prijs. Deel geen persoonlijke of betaalgegevens.",

    conciergeClose: "Conciërge sluiten",

    conciergeViewStay: "Bekijk verblijf",

    conciergePerNight: "per nacht",

    conciergeSuggestions: "Je kunt ook vragen",


    contact: "Contact opnemen",


    conciergeContact: "Meer hulp nodig? Neem contact op",

    checkoutMissing:
      "Voeg een uitcheckdatum toe.",
    checkinMissing:
      "Voeg een incheckdatum toe.",
    datesInvalid:
      "Uitchecken moet na inchecken zijn.",
    guestInvalid:
      "Minimaal 1 gast is vereist.",
  },
};