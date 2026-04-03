// InvestorDict Frontend Configuration

// 1. In production, place your external Render backend URL here (without trailing slash).
// e.g. 'https://investordict-backend.onrender.com'
const PROD_BACKEND_URL = 'https://investor-dict.onrender.com/';

// 2. Local development URL running via Docker Compose (Port 3001).
const LOCAL_BACKEND_URL = 'http://localhost:3001';

// 3. Environment selector: auto-detects based on the browser address bar.
const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// Global variable attached to 'window' so it can be accessed across all pages.
window.API_BASE_URL = isLocalhost ? LOCAL_BACKEND_URL : PROD_BACKEND_URL;
