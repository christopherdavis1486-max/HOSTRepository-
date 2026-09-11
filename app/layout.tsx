import { I18nProvider } from "@/components/I18nProvider";
import { AuthSessionProvider } from "@/components/AuthSessionProvider";

export const metadata = {
  title: "HOST",
  description: "HOST booking and payments backend",
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body><AuthSessionProvider><I18nProvider>{children}</I18nProvider></AuthSessionProvider></body>
    </html>
  )
}
