#!/usr/bin/env node
/**
 * Conformance checks of a Support Action Protocol implementation.
 *
 *   protocol-conformance --profile profile.json [--json]
 *
 * The profile is JSON with the ConformanceProfile fields; the secret can be passed in PROTOCOL_SECRET instead of the file.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { formatConformanceReport, runConformance, type ConformanceProfile } from './conformance.js';

const { values } = parseArgs({ options: { profile: { type: 'string' }, json: { type: 'boolean', default: false } } });
if (!values.profile) {
  console.error('Usage: protocol-conformance --profile profile.json [--json]');
  process.exit(2);
}
const profile = JSON.parse(readFileSync(values.profile, 'utf8')) as ConformanceProfile;
profile.secret = process.env.PROTOCOL_SECRET ?? profile.secret;
if (!profile.baseUrl || !profile.secret || !profile.customer?.identities) {
  console.error('The profile needs baseUrl, secret (or PROTOCOL_SECRET) and customer.identities');
  process.exit(2);
}

const report = await runConformance(profile);
console.log(values.json ? JSON.stringify(report, null, 2) : formatConformanceReport(report));
process.exit(report.ok ? 0 : 1);
