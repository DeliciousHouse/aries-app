import MarketingLayout from '../../frontend/marketing/MarketingLayout';
import { ButtonLink } from '@/components/redesign/primitives/button';
import { Card } from '@/components/redesign/primitives/card';
export default function ContactPage() {
  return (
    <MarketingLayout currentPath="/contact">
      <section className="rd-section">
        <div className="rd-container" style={{ maxWidth: '56rem', display: 'grid', gap: '1.5rem' }}>
          <div style={{ display: 'grid', gap: '1rem' }}>
            <span className="rd-section-label">Contact</span>
            <h1 className="rd-section-title">Questions about the Aries runtime?</h1>
            <p className="rd-section-description">
              The public contact route remains available so the URL stays stable, but submissions are intentionally disabled until a real intake workflow exists.
            </p>
          </div>

          <Card>
            <div style={{ display: 'grid', gap: '1rem' }}>
              <div className="rd-alert rd-alert--danger" role="alert">
                <div>
                  <strong style={{ display: 'block', marginBottom: '0.25rem' }}>No contact workflow is deployed</strong>
                  <span>`/api/contact` currently returns an explicit placeholder response instead of accepting submissions.</span>
                </div>
              </div>
              <p className="rd-section-description">
                This page stays live to preserve routing and explain the current contract honestly. If you need implementation details, the runtime and API docs describe the current boundary in full.
              </p>
              <div className="rd-hero__actions">
                <ButtonLink href="/documentation">Read the docs</ButtonLink>
                <ButtonLink href="/api-docs" variant="secondary">Review the API</ButtonLink>
              </div>
            </div>
          </Card>
        </div>
      </section>
    </MarketingLayout>
  );
}
