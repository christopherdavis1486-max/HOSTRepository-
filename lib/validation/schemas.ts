import { z } from "zod";

/** §46/§68 of the technical spec: every route validates input before it
 *  touches business logic, and never leaks a raw internal error back to
 *  the caller. These schemas are the single source of truth for what
 *  "valid input" means for each route — a route parses with `.safeParse`,
 *  and on failure returns the schema's own error messages, which are
 *  written to be safe to show a user (no internal field names, no SQL). */

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  password: z.string()
    .min(12, "Password must be at least 12 characters")
    .max(200, "Password is too long")
    .regex(/[A-Za-z]/, "Password must include at least one letter")
    .regex(/[0-9]/, "Password must include at least one number"),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password").max(200),
  newPassword: registerSchema.shape.password,
  confirmPassword: z.string().max(200),
}).refine((data) => data.newPassword === data.confirmPassword, {
  message: "New passwords do not match", path: ["confirmPassword"],
}).refine((data) => data.currentPassword !== data.newPassword, {
  message: "Choose a password you have not just been using", path: ["newPassword"],
});

export const createBookingSchema = z.object({
  propertyId: z.string().uuid("propertyId must be a valid property ID"),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "checkIn must be YYYY-MM-DD"),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "checkOut must be YYYY-MM-DD"),
  guests: z.number().int().min(1).max(50),
  guestName: z.string().trim().min(1, "Guest name is required").max(200),
  guestEmail: z.string().trim().toLowerCase().email("Enter a valid guest email"),
  guestPhone: z.string().trim().max(30).optional(),
})
  .refine(data => data.checkOut > data.checkIn, { message: "checkOut must be after checkIn", path: ["checkOut"] })
  // FOUND during Batch 9's audit and confirmed still absent: no check
  // anywhere rejected a check-in date in the past. Compared as plain
  // "YYYY-MM-DD" strings against today's own date in the same format —
  // safe and unambiguous for date-only values, matching how these
  // strings are used everywhere else in this codebase (no time-of-day
  // component to reason about).
  .refine(data => data.checkIn >= new Date().toISOString().slice(0, 10), {
    message: "checkIn cannot be in the past", path: ["checkIn"],
  })
  // Batch 9, item 11: a deliberate 12-month maximum advance-booking
  // horizon — also confirmed absent by the earlier audit (a booking could
  // previously be made arbitrarily far ahead, which is exactly what
  // exposed the payment-architecture funds-control problem this whole
  // batch exists to address).
  .refine(data => {
    const maxAdvance = new Date();
    maxAdvance.setUTCMonth(maxAdvance.getUTCMonth() + 12);
    return data.checkIn <= maxAdvance.toISOString().slice(0, 10);
  }, { message: "checkIn cannot be more than 12 months in advance", path: ["checkIn"] });

export const cancelBookingSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const createPaymentIntentSchema = z.object({
  bookingId: z.string().uuid("bookingId must be a valid booking ID"),
});

export const hostOnboardingStartSchema = z.object({
  country: z.string().length(2, "country must be a 2-letter ISO code (e.g. GB, DE)").toUpperCase(),
});

export const adminRefundSchema = z.object({
  bookingId: z.string().uuid("bookingId must be a valid booking ID"),
  amountMinor: z.number().int().positive("amountMinor must be a positive integer (minor currency units)"),
  reason: z.enum(["admin_goodwill", "dispute", "host_cancellation", "pricing_error"], {
    errorMap: () => ({ message: "reason must be one of admin_goodwill, dispute, host_cancellation, pricing_error" }),
  }),
});

export const sendMessageSchema = z.object({
  body: z.string().trim().min(1, "Message body is required").max(5000, "Message is too long"),
  attachmentUrl: z.string().url("attachmentUrl must be a valid URL").optional(),
});

export const createReviewSchema = z.object({
  overall: z.number().int().min(1).max(5),
  cleanliness: z.number().int().min(1).max(5).optional(),
  location: z.number().int().min(1).max(5).optional(),
  accuracy: z.number().int().min(1).max(5).optional(),
  communication: z.number().int().min(1).max(5).optional(),
  comfort: z.number().int().min(1).max(5).optional(),
  body: z.string().trim().max(3000).optional(),
});

export const reviewReplySchema = z.object({
  reply: z.string().trim().min(1, "Reply cannot be empty").max(2000),
});

export const propertySearchQuerySchema = z.object({
  city: z.string().trim().min(1).max(100).optional(),
  district: z.string().trim().min(1).max(100).optional(),
  guests: z.coerce.number().int().min(1).max(50).optional(),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "checkIn must be YYYY-MM-DD").optional(),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "checkOut must be YYYY-MM-DD").optional(),
}).refine(
  (data) => (data.checkIn == null) === (data.checkOut == null),
  { message: "checkIn and checkOut must both be provided together, or neither" }
).refine(
  (data) => !data.checkIn || !data.checkOut || data.checkOut > data.checkIn,
  { message: "checkOut must be after checkIn", path: ["checkOut"] }
);

const VALID_PROPERTY_STATUSES = ["draft", "published", "paused"] as const;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * FOUND during a real, reproduced production defect: GET
 * /api/host/properties/[id] returns check_in_time/check_out_time exactly
 * as Postgres's TIME column stores them — "HH:MM:SS" — but this schema
 * previously only accepted "HH:MM". The property edit page's own
 * loadProperty() feeds that GET response directly into form state, so
 * ANY save from a freshly-loaded edit form (not just one touching
 * amenities) sent "15:00:00" back and failed validation outright — the
 * whole PATCH request 400'd before updatePropertyForHost() ever ran,
 * which is why amenity selections appeared to silently not persist:
 * they were never reached at all. Reproduced directly against a real
 * database with the exact payload a real edit form generates before
 * writing this fix. Slicing to the first 5 characters normalizes either
 * shape to "HH:MM" before the regex check, so both a fresh "15:00" and a
 * round-tripped "15:00:00" validate identically.
 */
const timeField = () => z.preprocess(
  (val) => (typeof val === "string" ? val.slice(0, 5) : val),
  z.string().regex(TIME_PATTERN, "must be HH:MM")
);


export const createPropertySchema = z.object({
  name: z.string().trim().min(1, "Property name is required").max(200),
  propertyType: z.preprocess((v) => (v === "" ? undefined : v), z.string().trim().min(1).max(100).optional()),
  description: z.string().trim().max(5000).optional(),
  city: z.string().trim().min(1, "City is required").max(100),
  district: z.string().trim().max(100).optional(),
  countryCode: z.preprocess((v) => (v === "" ? undefined : v), z.string().trim().length(2, "Country code must be a 2-letter ISO code").optional()),
  maxGuests: z.coerce.number().int().min(1, "Must accommodate at least 1 guest"),
  bedrooms: z.coerce.number().int().min(0),
  bathrooms: z.coerce.number().min(0),
  nightlyPrice: z.coerce.number().positive("Nightly price must be greater than zero"),
  cleaningFee: z.coerce.number().min(0).optional(),
  currency: z.preprocess((v) => (v === "" ? undefined : v), z.string().trim().length(3, "Currency must be a 3-letter ISO code").optional()),
  checkInTime: timeField().optional(),
  checkOutTime: timeField().optional(),
  houseRules: z.string().trim().max(5000).optional(),
  status: z.enum(VALID_PROPERTY_STATUSES).optional(),
  amenityIds: z.array(z.string().uuid()).optional(),
});

export const updatePropertySchema = createPropertySchema.partial();

const complianceCategorySchema = z.enum([
  "authority_to_list", "fire_safety", "gas_safety", "electrical_safety",
  "smoke_co_alarms", "public_liability_insurance", "licences_permissions",
]);

const conditionallyApplicableComplianceCategories = new Set(["gas_safety", "licences_permissions"]);

export const ownerComplianceSchema = z.object({
  submit: z.boolean().default(false),
  items: z.array(z.object({
    category: complianceCategorySchema,
    applicability: z.enum(["required", "not_applicable"]),
    ownerDeclaredCompliant: z.boolean(),
    evidenceUrl: z.string().trim().max(2048).nullable().optional(),
    evidenceReference: z.string().trim().max(200).nullable().optional(),
    validUntil: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal(""), z.null()]).optional(),
    ownerNote: z.string().trim().max(1000).nullable().optional(),
  })).length(7).refine((items) => new Set(items.map((item) => item.category)).size === 7, "Each compliance category must appear exactly once"),
}).superRefine((data, context) => {
  data.items.forEach((item, index) => {
    if (item.applicability === "not_applicable" && !conditionallyApplicableComplianceCategories.has(item.category)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["items", index, "applicability"], message: "This core compliance check is always required" });
    }
    if (item.applicability === "required") {
      const evidenceUrl = item.evidenceUrl ?? "";
      let validHttpsUrl = false;
      try { validHttpsUrl = new URL(evidenceUrl).protocol === "https:"; } catch { validHttpsUrl = false; }
      if (!validHttpsUrl) context.addIssue({ code: z.ZodIssueCode.custom, path: ["items", index, "evidenceUrl"], message: "Enter a valid HTTPS evidence link" });
    }
  });
});

export const adminComplianceReviewSchema = z.object({
  decision: z.enum(["approved", "changes_required"]),
  note: z.string().trim().min(8, "Review note must be at least 8 characters").max(2000),
});

export const availabilityActionSchema = z.object({
  action: z.enum(["block", "unblock"]),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "checkIn must be YYYY-MM-DD"),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "checkOut must be YYYY-MM-DD"),
}).refine((data) => data.checkOut > data.checkIn, { message: "checkOut must be after checkIn", path: ["checkOut"] });

export const notificationPreferencesSchema = z.object({
  email: z.boolean().optional(),
  push: z.boolean().optional(),
  sms: z.boolean().optional(),
});

export const accountProfileSchema = z.object({
  fullName: z.string().trim().max(120, "Name must be 120 characters or fewer").nullable(),
  phone: z.string().trim().max(30, "Phone number must be 30 characters or fewer").nullable(),
});

export const savePropertySchema = z.object({
  propertyId: z.string().uuid("propertyId must be a valid property ID"),
});

export const passwordResetRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
});

export const passwordResetConfirmSchema = z.object({
  token: z.string().min(1, "token is required"),
  newPassword: z.string()
    .min(12, "Password must be at least 12 characters")
    .max(200, "Password is too long")
    .regex(/[A-Za-z]/, "Password must include at least one letter")
    .regex(/[0-9]/, "Password must include at least one number"),
});

/** Shared helper so every route formats a Zod failure the same way,
 *  rather than each route hand-rolling its own 400 response shape. */
export function validationErrorResponse(error: z.ZodError) {
  return {
    success: false as const,
    error: {
      code: "INVALID_INPUT",
      message: error.errors.map(e => `${e.path.join(".")}: ${e.message}`).join("; "),
    },
  };
}
