import type { RequestHandler } from './$types';
import { Effect, Schema } from 'effect';
import { rateLimitResponse } from '$lib/server/auth-rate-limit-response';
import { AppConfig } from '$lib/server/config';
import { runEdge } from '$lib/server/edge';
import { InvalidRequest, NotFound } from '$lib/server/errors';
import {
	REPORT_DETAILS_MAX,
	REPORT_REASONS,
	ReportCreateSchema,
	hashReporterIp
} from '$lib/server/report-policy';
import { readBoundedJson, readBoundedText } from '$lib/server/request-json';
import { Admin } from '$lib/server/services/admin';
import { RateLimits } from '$lib/server/services/rate-limits';

// Abuse reports, on the content host that serves the file: anyone can
// file one, nobody has to sign in. GET renders the one form the site 404
// page and public file links point at; POST takes the form or JSON.

const MAX_BODY_BYTES = 8 * 1024;

const escapeHtml = (value: string) =>
	value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');

const page = (body: string, status = 200) =>
	new Response(
		`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Report content</title>
<style>
body{margin:0;padding:48px 20px;font:15px/1.5 system-ui,sans-serif;color:#09090b;background:#fff}
main{max-width:28rem;margin:0 auto}
h1{font-size:1.25rem;font-weight:600;margin:0 0 20px}
label{display:block;font-weight:500;margin-top:16px}
select,textarea,input{display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:8px 10px;font:inherit;border:1px solid #d4d4d8;border-radius:6px;background:#fff;color:inherit}
textarea{min-height:6rem;resize:vertical}
button{margin-top:20px;padding:8px 14px;font:inherit;font-weight:500;color:#fff;background:#09090b;border:0;border-radius:6px;cursor:pointer}
p{color:#52525b}
code{font-size:.9em}
</style>
</head>
<body><main>${body}</main></body>
</html>`,
		{
			status,
			headers: {
				'Content-Type': 'text/html; charset=utf-8',
				'Cache-Control': 'private, no-store',
				'Content-Security-Policy':
					"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
				'Referrer-Policy': 'no-referrer',
				'X-Content-Type-Options': 'nosniff'
			}
		}
	);

const form = (fileId: string) => {
	const options = REPORT_REASONS.map(
		(reason) =>
			`<option value="${reason}">${reason[0]?.toUpperCase()}${reason.slice(1)}</option>`
	).join('');
	return page(`<h1>Report content</h1>
<form method="post" action="/report">
<input type="hidden" name="fileId" value="${escapeHtml(fileId)}">
<label>Reason<select name="reason" required>${options}</select></label>
<label>Details<textarea name="details" maxlength="${REPORT_DETAILS_MAX}"></textarea></label>
<button type="submit">Send report</button>
</form>`);
};

const readForm = (request: Request) =>
	readBoundedText(request, {
		maxBytes: MAX_BODY_BYTES,
		invalidLengthMessage: 'Report is too large',
		invalidTextMessage: 'Report form is invalid'
	}).pipe(
		Effect.map((text) => {
			const params = new URLSearchParams(text);
			return {
				fileId: params.get('fileId') ?? '',
				reason: params.get('reason') ?? '',
				...(params.get('details') ? { details: params.get('details') } : {})
			};
		})
	);

const readReport = (request: Request) =>
	Effect.gen(function* () {
		const isForm = (request.headers.get('content-type') ?? '').includes(
			'application/x-www-form-urlencoded'
		);
		const raw: unknown = isForm
			? yield* readForm(request)
			: yield* readBoundedJson(request, {
					maxBytes: MAX_BODY_BYTES,
					invalidLengthMessage: 'Report is too large',
					invalidJsonMessage: 'A JSON report is required'
				});
		const decoded = yield* Schema.decodeUnknownEffect(ReportCreateSchema)(
			raw
		).pipe(
			Effect.mapError(
				() =>
					new InvalidRequest({
						status: 400,
						message: `A file id and a reason (${REPORT_REASONS.join(', ')}) are required`
					})
			)
		);
		return { ...decoded, isForm };
	});

export const GET: RequestHandler = ({ url }) => {
	const fileId = url.searchParams.get('f')?.trim() ?? '';
	if (!fileId || fileId.length > 128) {
		return page(
			'<h1>Report content</h1><p>Open this page from the file you want to report.</p>',
			404
		);
	}
	return form(fileId);
};

export const POST: RequestHandler = (event) =>
	runEdge(
		Effect.gen(function* () {
			const admin = yield* Admin;
			const config = yield* AppConfig;
			const rateLimits = yield* RateLimits;
			const org = event.locals.content;
			if (!org) return yield* new NotFound({ id: 'report' });
			const ip = event.getClientAddress();
			const rateLimit = yield* rateLimits.anonymous(ip);
			if (!rateLimit.allowed) return rateLimitResponse();
			const report = yield* readReport(event.request);
			const reporterIpHash = yield* Effect.promise(() =>
				hashReporterIp(ip, config.maintenanceSecret)
			);
			const id = yield* admin.fileReport({
				orgId: org.orgId,
				fileId: report.fileId,
				reason: report.reason,
				details: report.details?.trim() || null,
				reporterIpHash
			});
			if (report.isForm) {
				return page(
					'<h1>Thank you</h1><p>The report was received and will be reviewed.</p>'
				);
			}
			return Response.json(
				{ id },
				{ status: 201, headers: { 'Cache-Control': 'private, no-store' } }
			);
		})
	);
