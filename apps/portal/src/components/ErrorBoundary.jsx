import React from 'react';
import { clearStoredSession } from '../lib/session.js';

/**
 * Last line of defence: a render error must never leave a clinician staring at a
 * blank white page. We show a recoverable fallback and offer a way out.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.handleRecover = this.handleRecover.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Message only - never dump request payloads or session data to the console.
    if (typeof console !== 'undefined') {
      console.error('[portal] render error:', error?.message, info?.componentStack);
    }
  }

  handleRecover() {
    clearStoredSession();
    if (typeof window !== 'undefined') window.location.reload();
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="app fallback-screen" role="alert">
        <div className="panel fallback-card">
          <p className="eyebrow">PORTAL RECOVERY</p>
          <h1>Something went wrong on this screen</h1>
          <p className="muted">
            The dispatch console hit an unexpected error. Reloading restores the live view; your session data is kept only
            in this browser tab.
          </p>
          <div className="fallback-actions">
            <button type="button" onClick={() => window.location.reload()}>
              Reload the portal
            </button>
            <button type="button" className="secondary" onClick={this.handleRecover}>
              Clear session and reload
            </button>
          </div>
        </div>
      </main>
    );
  }
}
