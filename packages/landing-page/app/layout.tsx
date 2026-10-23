import type {Metadata} from 'next';
import '@fontsource-variable/instrument-sans/index.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import '@fontsource/inter-tight/600.css';
import '@fontsource/inter-tight/700.css';
import '@fontsource/inter-tight/800.css';
import './globals.css';
export const metadata:Metadata={title:{default:'Valasys Mail — Email the accounts ready to buy',template:'%s | Valasys Mail'},description:'B2B email marketing, automation and a sending API powered by VAIS buyer-intent data.'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>;}
