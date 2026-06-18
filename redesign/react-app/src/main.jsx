import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App.jsx'
import Product from './Product.jsx'
import './index.css'

// The REAL app (login → role-based UI + live API) is the default everywhere —
// `npm run dev`, `npm start`, and the deployed site all open on the LOGIN screen.
// The design-review explorer (mock data, spec pages) is opt-in: used only by the
// standalone prototype build (VITE_APP_MODE='explorer') or by adding ?explore=1.
const isExplorer =
  import.meta.env.VITE_APP_MODE === 'explorer' ||
  (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('explore'))

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isExplorer ? <HashRouter><App /></HashRouter> : <Product />}
  </React.StrictMode>,
)
