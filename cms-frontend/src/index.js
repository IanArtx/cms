import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';

// v1.82.1 — "ResizeObserver loop completed with undelivered notifications"
// is a harmless browser notice (a size watcher had more to report than one
// screen refresh allowed), not a fault. The development server showed it
// as a full-screen "Uncaught runtime errors" panel. The cause in the
// document preview is fixed (ScaledDocumentFrame); this stops any other
// harmless one from covering the screen. Real errors still show.
const isResizeObserverNotice = (msg) => /ResizeObserver loop (completed with undelivered notifications|limit exceeded)/i.test(String(msg || ''));
window.addEventListener('error', (e) => {
  if (isResizeObserverNotice(e?.message)) {
    e.stopImmediatePropagation();
    e.preventDefault();
  }
}, true);

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
