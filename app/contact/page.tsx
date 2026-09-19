"use client";

import {
  FormEvent,
  useEffect,
  useState,
} from "react";
import { LanguageSelector } from "@/components/LanguageSelector";
import { useI18n } from "@/components/I18nProvider";
import type { Locale } from "@/lib/i18n/config";
import "./contact.css";

type Category =
  | "general"
  | "booking"
  | "payment"
  | "cancellation"
  | "property"
  | "hosting"
  | "accessibility"
  | "safety"
  | "complaint"
  | "other";

type Copy = {
  eyebrow: string;
  title: string;
  introduction: string;
  name: string;
  email: string;
  category: string;
  bookingReference: string;
  optional: string;
  message: string;
  messagePlaceholder: string;
  send: string;
  sending: string;
  successTitle: string;
  successBody: string;
  error: string;
  privacy: string;
  emergency: string;
  back: string;
  categories: Record<Category, string>;
};

const copy: Record<Locale, Copy> = {
  en: {
    eyebrow: "GUEST SUPPORT",
    title: "Contact HOST",
    introduction:
      "Send us your question and the HOST team will reply by email.",
    name: "Full name",
    email: "Email address",
    category: "What can we help with?",
    bookingReference: "Booking reference",
    optional: "optional",
    message: "Message",
    messagePlaceholder:
      "Tell us what happened and what help you need.",
    send: "Send message",
    sending: "Sending...",
    successTitle: "Your message has been sent",
    successBody:
      "Thank you. The HOST team will reply to the email address you provided.",
    error:
      "We could not send your message. Please check the details and try again.",
    privacy:
      "Do not include passwords, payment-card numbers or identity documents.",
    emergency:
      "HOST is not an emergency service. If anyone is in immediate danger, contact the local emergency services.",
    back: "Back to HOST",
    categories: {
      general: "General question",
      booking: "Existing booking",
      payment: "Payment",
      cancellation: "Cancellation",
      property: "Property question",
      hosting: "Hosting with HOST",
      accessibility: "Accessibility",
      safety: "Safety concern",
      complaint: "Complaint",
      other: "Other",
    },
  },
  de: {
    eyebrow: "GAESTESERVICE",
    title: "HOST kontaktieren",
    introduction:
      "Senden Sie uns Ihre Frage. Das HOST-Team antwortet per E-Mail.",
    name: "Vollstaendiger Name",
    email: "E-Mail-Adresse",
    category: "Wobei koennen wir helfen?",
    bookingReference: "Buchungsnummer",
    optional: "optional",
    message: "Nachricht",
    messagePlaceholder:
      "Beschreiben Sie, was passiert ist und welche Hilfe Sie benoetigen.",
    send: "Nachricht senden",
    sending: "Wird gesendet...",
    successTitle: "Ihre Nachricht wurde gesendet",
    successBody:
      "Vielen Dank. Das HOST-Team antwortet an die angegebene E-Mail-Adresse.",
    error:
      "Die Nachricht konnte nicht gesendet werden. Bitte pruefen Sie Ihre Angaben.",
    privacy:
      "Geben Sie keine Passwoerter, Kartennummern oder Ausweisdokumente an.",
    emergency:
      "HOST ist kein Notdienst. Bei unmittelbarer Gefahr wenden Sie sich an den oertlichen Notruf.",
    back: "Zurueck zu HOST",
    categories: {
      general: "Allgemeine Frage",
      booking: "Bestehende Buchung",
      payment: "Zahlung",
      cancellation: "Stornierung",
      property: "Frage zur Unterkunft",
      hosting: "Gastgeber bei HOST",
      accessibility: "Barrierefreiheit",
      safety: "Sicherheitsbedenken",
      complaint: "Beschwerde",
      other: "Sonstiges",
    },
  },
  fr: {
    eyebrow: "ASSISTANCE VOYAGEURS",
    title: "Contacter HOST",
    introduction:
      "Envoyez-nous votre question. L'equipe HOST vous repondra par e-mail.",
    name: "Nom complet",
    email: "Adresse e-mail",
    category: "Comment pouvons-nous vous aider ?",
    bookingReference: "Reference de reservation",
    optional: "facultatif",
    message: "Message",
    messagePlaceholder:
      "Expliquez-nous la situation et l'aide dont vous avez besoin.",
    send: "Envoyer le message",
    sending: "Envoi...",
    successTitle: "Votre message a ete envoye",
    successBody:
      "Merci. L'equipe HOST repondra a l'adresse e-mail indiquee.",
    error:
      "Votre message n'a pas pu etre envoye. Verifiez les informations et reessayez.",
    privacy:
      "N'indiquez aucun mot de passe, numero de carte ou document d'identite.",
    emergency:
      "HOST n'est pas un service d'urgence. En cas de danger immediat, contactez les secours locaux.",
    back: "Retour a HOST",
    categories: {
      general: "Question generale",
      booking: "Reservation existante",
      payment: "Paiement",
      cancellation: "Annulation",
      property: "Question sur un logement",
      hosting: "Devenir hote",
      accessibility: "Accessibilite",
      safety: "Probleme de securite",
      complaint: "Reclamation",
      other: "Autre",
    },
  },
  es: {
    eyebrow: "ATENCION AL HUESPED",
    title: "Contactar con HOST",
    introduction:
      "Envianos tu pregunta y el equipo de HOST respondera por correo electronico.",
    name: "Nombre completo",
    email: "Correo electronico",
    category: "En que podemos ayudarte?",
    bookingReference: "Referencia de reserva",
    optional: "opcional",
    message: "Mensaje",
    messagePlaceholder:
      "Cuentanos que ha ocurrido y que ayuda necesitas.",
    send: "Enviar mensaje",
    sending: "Enviando...",
    successTitle: "Tu mensaje ha sido enviado",
    successBody:
      "Gracias. El equipo de HOST respondera al correo indicado.",
    error:
      "No pudimos enviar el mensaje. Revisa los datos e intentalo de nuevo.",
    privacy:
      "No incluyas contrasenas, numeros de tarjeta ni documentos de identidad.",
    emergency:
      "HOST no es un servicio de emergencias. Si existe peligro inmediato, contacta con los servicios locales.",
    back: "Volver a HOST",
    categories: {
      general: "Pregunta general",
      booking: "Reserva existente",
      payment: "Pago",
      cancellation: "Cancelacion",
      property: "Pregunta sobre una propiedad",
      hosting: "Alojar con HOST",
      accessibility: "Accesibilidad",
      safety: "Problema de seguridad",
      complaint: "Reclamacion",
      other: "Otro",
    },
  },
  it: {
    eyebrow: "ASSISTENZA OSPITI",
    title: "Contatta HOST",
    introduction:
      "Inviaci la tua domanda. Il team HOST rispondera via e-mail.",
    name: "Nome completo",
    email: "Indirizzo e-mail",
    category: "Come possiamo aiutarti?",
    bookingReference: "Riferimento prenotazione",
    optional: "facoltativo",
    message: "Messaggio",
    messagePlaceholder:
      "Descrivi cosa e successo e quale aiuto ti serve.",
    send: "Invia messaggio",
    sending: "Invio...",
    successTitle: "Il messaggio e stato inviato",
    successBody:
      "Grazie. Il team HOST rispondera all'indirizzo e-mail indicato.",
    error:
      "Non e stato possibile inviare il messaggio. Controlla i dati e riprova.",
    privacy:
      "Non inserire password, numeri di carta o documenti di identita.",
    emergency:
      "HOST non e un servizio di emergenza. In caso di pericolo immediato, contatta i servizi locali.",
    back: "Torna a HOST",
    categories: {
      general: "Domanda generale",
      booking: "Prenotazione esistente",
      payment: "Pagamento",
      cancellation: "Cancellazione",
      property: "Domanda sulla struttura",
      hosting: "Ospitare con HOST",
      accessibility: "Accessibilita",
      safety: "Problema di sicurezza",
      complaint: "Reclamo",
      other: "Altro",
    },
  },
  nl: {
    eyebrow: "GASTENSERVICE",
    title: "Contact opnemen",
    introduction:
      "Stuur ons uw vraag. Het HOST-team antwoordt per e-mail.",
    name: "Volledige naam",
    email: "E-mailadres",
    category: "Waarmee kunnen we helpen?",
    bookingReference: "Boekingsreferentie",
    optional: "optioneel",
    message: "Bericht",
    messagePlaceholder:
      "Vertel wat er is gebeurd en welke hulp u nodig heeft.",
    send: "Bericht verzenden",
    sending: "Verzenden...",
    successTitle: "Uw bericht is verzonden",
    successBody:
      "Bedankt. Het HOST-team antwoordt op het opgegeven e-mailadres.",
    error:
      "Het bericht kon niet worden verzonden. Controleer de gegevens en probeer opnieuw.",
    privacy:
      "Vermeld geen wachtwoorden, kaartnummers of identiteitsdocumenten.",
    emergency:
      "HOST is geen nooddienst. Neem bij direct gevaar contact op met de lokale hulpdiensten.",
    back: "Terug naar HOST",
    categories: {
      general: "Algemene vraag",
      booking: "Bestaande boeking",
      payment: "Betaling",
      cancellation: "Annulering",
      property: "Vraag over accommodatie",
      hosting: "Verhuren via HOST",
      accessibility: "Toegankelijkheid",
      safety: "Veiligheidsprobleem",
      complaint: "Klacht",
      other: "Anders",
    },
  },
};

const categoryValues: Category[] = [
  "general",
  "booking",
  "payment",
  "cancellation",
  "property",
  "hosting",
  "accessibility",
  "safety",
  "complaint",
  "other",
];

export default function ContactPage() {
  const { locale } = useI18n();
  const text = copy[locale] || copy.en;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [category, setCategory] =
    useState<Category>("general");
  const [bookingReference, setBookingReference] =
    useState("");
  const [message, setMessage] = useState("");
  const [website, setWebsite] = useState("");
  const [status, setStatus] = useState<
    "idle" | "sending" | "sent" | "error"
  >("idle");

  useEffect(() => {
    const params = new URLSearchParams(
      window.location.search,
    );
    const requestedCategory = params.get("category");

    if (
      requestedCategory &&
      categoryValues.includes(
        requestedCategory as Category,
      )
    ) {
      setCategory(requestedCategory as Category);
    }

    setBookingReference(
      params.get("bookingReference") || "",
    );
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("sending");

    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name,
          email,
          category,
          bookingReference:
            bookingReference.trim() || undefined,
          message,
          locale,
          website,
        }),
      });

      if (!response.ok) {
        throw new Error("CONTACT_FAILED");
      }

      setStatus("sent");
      setMessage("");
      setBookingReference("");
    } catch {
      setStatus("error");
    }
  }

  return (
    <main className="contact-page">
      <nav className="contact-nav">
        <a href="/" className="contact-logo">
          HOST
        </a>
        <LanguageSelector compact />
      </nav>

      <section className="contact-shell">
        <div className="contact-intro">
          <div className="contact-eyebrow">
            {text.eyebrow}
          </div>
          <h1>{text.title}</h1>
          <p>{text.introduction}</p>

          <div className="contact-notice">
            <p>{text.privacy}</p>
            <p>{text.emergency}</p>
          </div>
        </div>

        <div className="contact-card">
          {status === "sent" ? (
            <div className="contact-success" role="status">
              <span aria-hidden="true">{"\u2713"}</span>
              <h2>{text.successTitle}</h2>
              <p>{text.successBody}</p>
              <a href="/">{text.back}</a>
            </div>
          ) : (
            <form onSubmit={submit}>
              <div className="contact-grid">
                <label>
                  <span>{text.name}</span>
                  <input
                    name="name"
                    value={name}
                    onChange={(event) =>
                      setName(event.target.value)
                    }
                    minLength={2}
                    maxLength={100}
                    autoComplete="name"
                    required
                  />
                </label>

                <label>
                  <span>{text.email}</span>
                  <input
                    name="email"
                    type="email"
                    value={email}
                    onChange={(event) =>
                      setEmail(event.target.value)
                    }
                    maxLength={254}
                    autoComplete="email"
                    required
                  />
                </label>
              </div>

              <label>
                <span>{text.category}</span>
                <select
                  name="category"
                  value={category}
                  onChange={(event) =>
                    setCategory(
                      event.target.value as Category,
                    )
                  }
                >
                  {categoryValues.map((value) => (
                    <option key={value} value={value}>
                      {text.categories[value]}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>
                  {text.bookingReference}{" "}
                  <small>({text.optional})</small>
                </span>
                <input
                  name="bookingReference"
                  value={bookingReference}
                  onChange={(event) =>
                    setBookingReference(event.target.value)
                  }
                  maxLength={100}
                  autoComplete="off"
                />
              </label>

              <label>
                <span>{text.message}</span>
                <textarea
                  name="message"
                  value={message}
                  onChange={(event) =>
                    setMessage(event.target.value)
                  }
                  minLength={10}
                  maxLength={3000}
                  rows={7}
                  placeholder={text.messagePlaceholder}
                  required
                />
                <small className="contact-count">
                  {message.length}/3000
                </small>
              </label>

              <label
                className="contact-trap"
                aria-hidden="true"
              >
                Website
                <input
                  name="website"
                  value={website}
                  onChange={(event) =>
                    setWebsite(event.target.value)
                  }
                  tabIndex={-1}
                  autoComplete="off"
                />
              </label>

              {status === "error" && (
                <p className="contact-error" role="alert">
                  {text.error}
                </p>
              )}

              <button
                type="submit"
                disabled={status === "sending"}
              >
                {status === "sending"
                  ? text.sending
                  : text.send}
              </button>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}
