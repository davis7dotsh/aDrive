import { describe, expect, it } from 'vitest';
import { sniffKind, sniffMismatch } from './mime-sniff';

const bytes = (value: string | ReadonlyArray<number>) =>
	typeof value === 'string'
		? new TextEncoder().encode(value)
		: Uint8Array.from(value);

const pe = () => {
	const value = new Uint8Array(132);
	value.set([0x4d, 0x5a]);
	new DataView(value.buffer).setUint32(0x3c, 128, true);
	value.set([0x50, 0x45, 0, 0], 128);
	return value;
};

describe('mime sniffing', () => {
	it('recognises the signatures the scanner cares about', () => {
		expect(sniffKind(bytes('<!DOCTYPE html><html>'))).toBe('html');
		expect(sniffKind(bytes('  \n<script>alert(1)</script>'))).toBe('html');
		expect(sniffKind(bytes('<svg xmlns="http://www.w3.org/2000/svg">'))).toBe(
			'svg'
		);
		expect(
			sniffKind(bytes('<?xml version="1.0"?>\n<svg xmlns="x"></svg>'))
		).toBe('svg');
		expect(sniffKind(pe())).toBe('pe');
		expect(sniffKind(bytes([0x7f, 0x45, 0x4c, 0x46, 0x02]))).toBe('elf');
		expect(sniffKind(bytes([0xcf, 0xfa, 0xed, 0xfe]))).toBe('macho');
		expect(sniffKind(bytes('#!/bin/sh\nrm -rf /'))).toBe('shell-script');
		expect(
			sniffKind(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
		).toBe('png');
		expect(sniffKind(bytes('%PDF-1.7'))).toBe('pdf');
		expect(sniffKind(bytes('plain words'))).toBe('unknown');
		expect(sniffKind(bytes(''))).toBe('unknown');
	});

	it('recognizes BOM-prefixed active markup and avoids plain MZ text', () => {
		expect(sniffMismatch(bytes('\uFEFF<html>'), 'image/png').verdict).toBe(
			'suspicious'
		);
		expect(sniffMismatch(bytes('\uFEFF<svg/>'), 'text/plain').verdict).toBe(
			'suspicious'
		);
		expect(
			sniffMismatch(bytes('MZ notes from the meeting'), 'text/plain').verdict
		).toBe('clean');
		const invalid = pe();
		new DataView(invalid.buffer).setUint32(0x3c, 0xffffffff, true);
		expect(sniffKind(invalid)).toBe('unknown');
	});

	it('keeps a plausible executable with its PE signature beyond the prefix suspicious', () => {
		const prefix = new Uint8Array(512);
		prefix.set([0x4d, 0x5a]);
		new DataView(prefix.buffer).setUint32(0x3c, 1024, true);
		expect(sniffMismatch(prefix, 'image/png', 2048).verdict).toBe('suspicious');
		expect(sniffKind(prefix, 1000)).toBe('unknown');
		expect(sniffKind(bytes('MZ notes '.repeat(20)))).toBe('unknown');
	});

	it('flags active content declared as something benign', () => {
		expect(
			sniffMismatch(bytes('<html><script>x</script>'), 'text/plain').verdict
		).toBe('suspicious');
		expect(sniffMismatch(bytes('<svg></svg>'), 'image/png').verdict).toBe(
			'suspicious'
		);
		expect(sniffMismatch(pe(), 'image/jpeg').verdict).toBe('suspicious');
		expect(sniffMismatch(bytes('#!/bin/bash'), 'image/gif').verdict).toBe(
			'suspicious'
		);
	});

	it('accepts active content under its own type and ignores passive kinds', () => {
		expect(
			sniffMismatch(bytes('<!doctype html>'), 'text/html; charset=utf-8')
				.verdict
		).toBe('clean');
		expect(sniffMismatch(bytes('<svg/>'), 'image/svg+xml').verdict).toBe(
			'clean'
		);
		expect(sniffMismatch(pe(), 'application/octet-stream').verdict).toBe(
			'clean'
		);
		expect(sniffMismatch(bytes('#!/bin/sh'), 'text/plain').verdict).toBe(
			'clean'
		);
		expect(sniffMismatch(bytes('%PDF-1.4'), 'text/plain').verdict).toBe(
			'clean'
		);
		expect(sniffMismatch(bytes('hello'), 'text/html').verdict).toBe('clean');
	});
});
