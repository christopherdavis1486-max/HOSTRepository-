import { z } from "zod";

export const createCalendarFeedSchema = z.object({
  name: z.string()
    .trim()
    .min(1, "Enter a calendar name")
    .max(120, "Calendar name must be 120 characters or fewer"),

  feedUrl: z.string()
    .trim()
    .url("Enter a valid calendar URL")
    .max(4000, "Calendar URL is too long")
    .refine(
      (value) => {
        try {
          const url = new URL(value);
          return (
            url.protocol === "https:" &&
            !url.username &&
            !url.password &&
            (!url.port || url.port === "443")
          );
        } catch {
          return false;
        }
      },
      "Calendar URL must use standard HTTPS without embedded credentials",
    ),
});

export const updateCalendarFeedSchema = z.object({
  isActive: z.boolean(),
});

export const calendarFeedIdSchema = z.string()
  .uuid("Calendar feed ID is invalid");

export const calendarExportTokenSchema = z.string()
  .uuid("Calendar export token is invalid");
