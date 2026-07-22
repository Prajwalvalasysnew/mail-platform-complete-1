// CANSPAM-04 (compliance implementation plan): tamper-resistant compliance
// footer.
//
// The physical postal address and working unsubscribe link that CAN-SPAM
// §5(a)(5) requires are appended HERE, after template rendering and tracking
// transforms, so no customer-supplied template, variable, or content can
// remove or displace them. The address is HTML-escaped on the way in — a
// crafted "address" cannot inject markup, close our container, or smuggle a
// fake unsubscribe target into the footer.

export function escapeFooterHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface CompliantFooterInput {
  html: string | null | undefined;
  text: string | null | undefined;
  physicalAddress: string;
  unsubUrl: string;
}

export interface CompliantFooterOutput {
  html: string | null;
  text: string | null;
}

/** Append the CAN-SPAM footer to every present body format. */
export function appendCompliantFooter(input: CompliantFooterInput): CompliantFooterOutput {
  const safeAddressHtml = escapeFooterHtml(input.physicalAddress).replace(/\n/g, '<br>');
  const safeUrl = escapeFooterHtml(input.unsubUrl);
  let html = input.html ?? null;
  let text = input.text ?? null;
  if (html != null) {
    html += `\n<div style="font-size:11px;color:#888;margin-top:24px;border-top:1px solid #eee;padding-top:8px;">${safeAddressHtml} &nbsp;&bull;&nbsp; <a href="${safeUrl}">Unsubscribe</a></div>`;
  }
  if (text != null) {
    text += `\n\n--\n${input.physicalAddress}\nUnsubscribe: ${input.unsubUrl}`;
  }
  return { html, text };
}
