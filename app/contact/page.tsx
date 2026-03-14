import MarketingLayout from '../../frontend/marketing/MarketingLayout';
export default function ContactPage() {
  return (
    <MarketingLayout currentPath="/contact">
      <section className="section page-contact">
        <div className="container" style={{ maxWidth: 640 }}>
          <div className="section-header">
            <span className="section-label">Contact</span>
            <h1 className="section-title">Get in Touch</h1>
            <p className="section-desc">
              Questions about Aries? Want a demo? We&apos;d love to hear from you.
            </p>
          </div>

          <div className="glass-card-static" style={{ display: 'grid', gap: '1rem' }}>
            <div className="alert alert-error" role="alert">
              Contact submissions are not available in this runtime. The `/api/contact` endpoint is an explicit placeholder until
              a real workflow is deployed.
            </div>
            <p style={{ margin: 0, color: 'rgba(248,245,242,0.75)' }}>
              This page remains visible so the public route does not 404, but the form has been removed to avoid implying that
              Aries can currently accept and process contact submissions.
            </p>
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
