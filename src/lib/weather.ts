import { z } from "zod";
import type { WeatherReport } from "./contracts.js";

/** The one product every merchant sells. Non-strict: extra fields (e.g. `note`) are allowed. */
export const WeatherReportSchema = z.object({
  city: z.string().min(1),
  tempC: z.number(),
  condition: z.string().min(1),
  humidity: z.number().min(0).max(100),
  observedAt: z.string().min(1),
});

export const PRODUCT_NAME = "Taipei weather report";
export const PRODUCT_DESCRIPTION =
  "Current Taipei weather as JSON: { city, tempC, condition, humidity, observedAt }.";

export function makeWeather(): WeatherReport {
  return {
    city: "Taipei",
    tempC: 24.5,
    condition: "Partly cloudy",
    humidity: 72,
    observedAt: new Date().toISOString(),
  };
}

export function isDelivered(body: unknown): boolean {
  return WeatherReportSchema.safeParse(body).success;
}
