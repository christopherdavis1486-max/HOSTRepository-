import { I18nProvider } from "@/components/I18nProvider";

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
      <body><I18nProvider>{children}</I18nProvider></body>
    </html>
  )
}
