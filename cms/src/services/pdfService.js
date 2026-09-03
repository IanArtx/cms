// ============================================================
// PDF SERVICE (v1.46.0)
// One shared "render this HTML to a PDF buffer" helper via headless
// Chrome (Puppeteer) — factored out of certificateService.js, which
// pioneered this exact technique for share certificates (Section
// 4.13/29), so any other module can reuse it without importing
// certificate-specific code. certificateService.js's own
// renderCertificatePdfBuffer now just delegates here.
//
// This remains the ONLY place in the codebase that launches
// Puppeteer — everywhere else that produces a "PDF" still relies on
// the browser's own native print-to-PDF (window.print(), via
// exportUtils.js's printDocument()). Each call launches and closes
// its own headless browser instance rather than keeping one running
// — simplest and safest for a low-frequency, scheduled-job-driven
// use case like this, at the cost of a real per-call cold-start (see
// the "known issues" note this already carries in Section 7.4 for
// certificate issuance — sending PDFs for a large membership one
// after another in a loop, as reportService.js's individual-report
// job now also does, inherits that exact same, already-accepted
// tradeoff rather than introducing a new one).
// ============================================================
const renderHtmlToPdfBuffer = async (html, options = {}) => {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' },
            ...options,
        });
        return pdfBuffer;
    } finally {
        await browser.close();
    }
};

module.exports = { renderHtmlToPdfBuffer };
