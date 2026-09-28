import { I18nProvider } from "@/components/I18nProvider";
import { AuthSessionProvider } from "@/components/AuthSessionProvider";
import { GuestConcierge } from "@/components/GuestConcierge";
import "leaflet/dist/leaflet.css";

export const metadata = {
  title: "HOST",
  description: "HOST booking and payments backend",
  applicationName: "HOST City Living",
  appleWebApp: { capable: true, title: "HOST", statusBarStyle: "default" as const },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body><AuthSessionProvider><I18nProvider>{children}<GuestConcierge /></I18nProvider></AuthSessionProvider></body>
    </html>
  )
}
