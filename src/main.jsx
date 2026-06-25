import { StrictMode, useMemo, Component } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import LandingPage from './LandingPage.jsx'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import { PhantomWalletAdapter, SolflareWalletAdapter, WalletConnectWalletAdapter } from '@solana/wallet-adapter-wallets'
import '@solana/wallet-adapter-react-ui/styles.css'

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  render() {
    if (this.state.error) return (
      <div style={{ background: '#0a0a0f', color: '#ff5050', fontFamily: 'monospace', padding: 32, minHeight: '100vh' }}>
        <h2>App crashed</h2>
        <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{this.state.error?.message}{'\n\n'}{this.state.error?.stack}</pre>
        <button onClick={() => this.setState({ error: null })} style={{ marginTop: 16, padding: '8px 16px', cursor: 'pointer' }}>Retry</button>
      </div>
    )
    return this.props.children
  }
}

const RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com'

function Root () {
  const wallets = useMemo(() => [
    new PhantomWalletAdapter(),
    new SolflareWalletAdapter(),
    new WalletConnectWalletAdapter({
      network: 'mainnet-beta',
      options: {
        projectId: '01a7314408e23e20dbc552a68f8f8881',
        metadata: {
          name: 'BetaPlays',
          description: 'Solana beta token discovery',
          url: 'https://betaplays.fun',
          icons: ['https://betaplays.fun/favicon.ico'],
        },
      },
    }),
  ], [])

  return (
    <ConnectionProvider endpoint={RPC_ENDPOINT}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<LandingPage />} />
              <Route path="/app" element={<App />} />
              <Route path="*" element={<LandingPage />} />
            </Routes>
          </BrowserRouter>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </StrictMode>,
)