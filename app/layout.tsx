import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { Toaster } from '@/components/ui/sonner'
import './globals.css'

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] })
const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
})

export const metadata: Metadata = {
  title: 'Telegram Pro',
  description: 'Manage Your User Using Telegram Pro',
  generator: 'v0.app',
  icons: {
    icon: '/telegram-pro.jpg',
    apple: '/telegram-pro.jpg',
  },
  openGraph: {
    title: 'Telegram Pro',
    description: 'Manage Your User Using Telegram Pro',
    images: [{ url: '/telegram-pro.jpg', width: 1260, height: 1260, alt: 'Telegram Pro' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Telegram Pro',
    description: 'Manage Your User Using Telegram Pro',
    images: ['/telegram-pro.jpg'],
  },
}

export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: 'white' },
    { media: '(prefers-color-scheme: dark)', color: 'black' },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`dark ${geistSans.variable} ${geistMono.variable} bg-background`}>
      <body className="font-sans antialiased">
        {children}
        <Toaster position="top-center" richColors />
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
