import { z } from "zod";

/**
 * Every route validates input before touching business logic and never
 * exposes raw internal errors to the caller.
 */

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
})
  .refine(
    (data) => data.newPassword === data.confirmPassword,
    {
      message: "New passwords do not match",
      path: ["confirmPassword"],
    }
  )
  .refine(
    (data) => data.currentPassword !== data.newPassword,
    {
      message: "Choose a password you have not just been using",
      path: ["newPassword"],
    }
  );

export const createBookingSchema = z.object({
  propertyId: z.string().uuid("propertyId must be a valid property ID"),
  checkIn: z.string().regex(
    /^\d{4}-\d{2}-\d{2}$/,
    "checkIn must be YYYY-MM-DD"
  ),
  checkOut: z.string().regex(
    /^\d{4}-\d{2}-\d{2}$/,
    "checkOut must be YYYY-MM-DD"
  ),
  guests: z.number().int().min(1).max(50),
  guestName: z.string().trim().min(1, "Guest name is required").max(200),
  guestEmail: z.string()
    .trim()
    .toLowerCase()
    .email("Enter a valid guest email"),
  guestPhone: z.string().trim().max(30).optional(),
})
  .refine(
    (data) => data.checkOut > data.checkIn,
    {
      message: "checkOut must be after checkIn",
      path: ["checkOut"],
    }
  )
  .refine(
    (data) =>
      data.checkIn >= new Date().toISOString().slice(0, 10),
    {
      message: "checkIn cannot be in the past",
      path: ["checkIn"],
    }
  )
  .refine(
    (data) => {
      const maxAdvance = new Date();
      maxAdvance.setUTCMonth(maxAdvance.getUTCMonth() + 12);

      return (
        data.checkIn <= maxAdvance.toISOString().slice(0, 10)
      );
    },
    {
      message: "checkIn cannot be more than 12 months in advance",
      path: ["checkIn"],
    }
  );

export const cancelBookingSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const createPaymentIntentSchema = z.object({
  bookingId: z.string().uuid("bookingId must be a valid booking ID"),
});

export const hostOnboardingStartSchema = z.object({
  country: z.string()
    .trim()
    .length(2, "country must be a 2-letter ISO code")
    .toUpperCase()
    .refine(
      (country) => country === "GB",
      {
        message:
          "Pilot host onboarding is currently available in GB only",
      }
    ),
});

export const adminRefundSchema = z.object({
  bookingId: z.string().uuid("bookingId must be a valid booking ID"),
  amountMinor: z.number()
    .int()
    .positive(
      "amountMinor must be a positive integer (minor currency units)"
    ),
  reason: z.enum(
    [
      "admin_goodwill",
      "dispute",
      "host_cancellation",
      "pricing_error",
    ],
    {
      errorMap: () => ({
        message:
          "reason must be one of admin_goodwill, dispute, host_cancellation, pricing_error",
      }),
    }
  ),
});

export const sendMessageSchema = z.object({
  body: z.string()
    .trim()
    .min(1, "Message body is required")
    .max(5000, "Message is too long"),
  attachmentUrl: z.string()
    .url("attachmentUrl must be a valid URL")
    .optional(),
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
  reply: z.string()
    .trim()
    .min(1, "Reply cannot be empty")
    .max(2000),
});

export const propertySearchQuerySchema = z.object({
  city: z.string().trim().min(1).max(100).optional(),
  district: z.string().trim().min(1).max(100).optional(),
  guests: z.coerce.number().int().min(1).max(50).optional(),
  checkIn: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "checkIn must be YYYY-MM-DD")
    .optional(),
  checkOut: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "checkOut must be YYYY-MM-DD")
    .optional(),
})
  .refine(
    (data) =>
      (data.checkIn == null) === (data.checkOut == null),
    {
      message:
        "checkIn and checkOut must both be provided together, or neither",
    }
  )
  .refine(
    (data) =>
      !data.checkIn ||
      !data.checkOut ||
      data.checkOut > data.checkIn,
    {
      message: "checkOut must be after checkIn",
      path: ["checkOut"],
    }
  );

const VALID_PROPERTY_STATUSES = [
  "draft",
  "published",
  "paused",
] as const;

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Postgres TIME values may be returned as HH:MM:SS. Normalize those
 * values to HH:MM before validation so a freshly loaded property can be
 * saved without an unrelated time-format failure.
 */
const timeField = () =>
  z.preprocess(
    (value) =>
      typeof value === "string" ? value.slice(0, 5) : value,
    z.string().regex(TIME_PATTERN, "must be HH:MM")
  );

const propertySchema = z.object({
  name: z.string()
    .trim()
    .min(1, "Property name is required")
    .max(200),

  propertyType: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().trim().min(1).max(100).optional()
  ),

  description: z.string().trim().max(5000).optional(),

  city: z.string()
    .trim()
    .min(1, "City is required")
    .max(100),

  district: z.string().trim().max(100).optional(),

  countryCode: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string()
      .trim()
      .length(2, "Country code must be a 2-letter ISO code")
      .optional()
  ),

  maxGuests: z.coerce.number()
    .int()
    .min(1, "Must accommodate at least 1 guest"),

  bedrooms: z.coerce.number().int().min(0),

  bathrooms: z.coerce.number().min(0),

  nightlyPrice: z.coerce.number()
    .positive("Nightly price must be greater than zero"),

  cleaningFee: z.coerce.number().min(0).optional(),

  minStayNights: z.coerce.number()
    .int()
    .min(1)
    .max(365)
    .optional(),

  maxStayNights: z.coerce.number()
    .int()
    .min(1)
    .max(365)
    .optional(),

  cancellationPolicyId: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string()
      .uuid("Cancellation policy must be a valid ID")
      .nullable()
      .optional()
  ),

  currency: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string()
      .trim()
      .length(3, "Currency must be a 3-letter ISO code")
      .optional()
  ),

  checkInTime: timeField().optional(),
  checkOutTime: timeField().optional(),
  houseRules: z.string().trim().max(5000).optional(),
  status: z.enum(VALID_PROPERTY_STATUSES).optional(),
  amenityIds: z.array(z.string().uuid()).optional(),
});

const stayRangeIsValid = (data: {
  minStayNights?: number;
  maxStayNights?: number;
}) =>
  data.minStayNights === undefined ||
  data.maxStayNights === undefined ||
  data.minStayNights <= data.maxStayNights;

export const createPropertySchema = propertySchema.refine(
  stayRangeIsValid,
  {
    message:
      "Maximum stay must be greater than or equal to minimum stay",
    path: ["maxStayNights"],
  }
);

export const updatePropertySchema = propertySchema
  .partial()
  .refine(stayRangeIsValid, {
    message:
      "Maximum stay must be greater than or equal to minimum stay",
    path: ["maxStayNights"],
  });

const complianceCategorySchema = z.enum([
  "authority_to_list",
  "fire_safety",
  "gas_safety",
  "electrical_safety",
  "smoke_co_alarms",
  "public_liability_insurance",
  "licences_permissions",
]);

const conditionallyApplicableComplianceCategories = new Set([
  "gas_safety",
  "licences_permissions",
]);

export const ownerComplianceSchema = z.object({
  submit: z.boolean().default(false),
  items: z.array(
    z.object({
      category: complianceCategorySchema,
      applicability: z.enum(["required", "not_applicable"]),
      ownerDeclaredCompliant: z.boolean(),
      evidenceUrl: z.string()
        .trim()
        .max(2048)
        .nullable()
        .optional(),
      evidenceReference: z.string()
        .trim()
        .max(200)
        .nullable()
        .optional(),
      validUntil: z.union([
        z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        z.literal(""),
        z.null(),
      ]).optional(),
      ownerNote: z.string()
        .trim()
        .max(1000)
        .nullable()
        .optional(),
    })
  )
    .length(7)
    .refine(
      (items) =>
        new Set(items.map((item) => item.category)).size === 7,
      "Each compliance category must appear exactly once"
    ),
}).superRefine((data, context) => {
  data.items.forEach((item, index) => {
    if (
      item.applicability === "not_applicable" &&
      !conditionallyApplicableComplianceCategories.has(item.category)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items", index, "applicability"],
        message: "This core compliance check is always required",
      });
    }

    if (
      data.submit &&
      item.applicability === "required"
    ) {
      const evidenceUrl = item.evidenceUrl ?? "";
      let validHttpsUrl = false;

      try {
        validHttpsUrl =
          new URL(evidenceUrl).protocol === "https:";
      } catch {
        validHttpsUrl = false;
      }

      if (!validHttpsUrl) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", index, "evidenceUrl"],
          message: "Enter a valid HTTPS evidence link",
        });
      }
    }
  });
});

export const adminComplianceReviewSchema = z.object({
  decision: z.enum(["approved", "changes_required"]),
  note: z.string()
    .trim()
    .min(8, "Review note must be at least 8 characters")
    .max(2000),
});

export const availabilityActionSchema = z.object({
  action: z.enum(["block", "unblock"]),
  checkIn: z.string().regex(
    /^\d{4}-\d{2}-\d{2}$/,
    "checkIn must be YYYY-MM-DD"
  ),
  checkOut: z.string().regex(
    /^\d{4}-\d{2}-\d{2}$/,
    "checkOut must be YYYY-MM-DD"
  ),
}).refine(
  (data) => data.checkOut > data.checkIn,
  {
    message: "checkOut must be after checkIn",
    path: ["checkOut"],
  }
);

export const notificationPreferencesSchema = z.object({
  email: z.boolean().optional(),
  push: z.boolean().optional(),
  sms: z.boolean().optional(),
});

export const accountProfileSchema = z.object({
  fullName: z.string()
    .trim()
    .max(120, "Name must be 120 characters or fewer")
    .nullable(),
  phone: z.string()
    .trim()
    .max(30, "Phone number must be 30 characters or fewer")
    .nullable(),
});

export const savePropertySchema = z.object({
  propertyId: z.string()
    .uuid("propertyId must be a valid property ID"),
});

export const passwordResetRequestSchema = z.object({
  email: z.string()
    .trim()
    .toLowerCase()
    .email("Enter a valid email address"),
});

export const passwordResetConfirmSchema = z.object({
  token: z.string().min(1, "token is required"),
  newPassword: z.string()
    .min(12, "Password must be at least 12 characters")
    .max(200, "Password is too long")
    .regex(/[A-Za-z]/, "Password must include at least one letter")
    .regex(/[0-9]/, "Password must include at least one number"),
});

export function validationErrorResponse(error: z.ZodError) {
  return {
    success: false as const,
    error: {
      code: "INVALID_INPUT",
      message: error.errors
        .map(
          (issue) =>
            `${issue.path.join(".")}: ${issue.message}`
        )
        .join("; "),
    },
  };
}