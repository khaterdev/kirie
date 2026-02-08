---
name: pdf-editor
description: Read, merge, split, and extract text from PDF files
emoji: "\U0001F4C4"
version: "1.0.0"
requires:
  anyBins:
    - pdftk
    - qpdf
    - pdftotext
invocation:
  userInvocable: true
---

# PDF Editor

Manipulate PDF files: extract text, merge, split, and convert.

## Usage
- "Extract text from this PDF"
- "Merge these two PDFs"
- "Split this PDF into individual pages"

## How it works
Uses command-line PDF tools to manipulate files. Supports text extraction via `pdftotext`, merging/splitting via `pdftk` or `qpdf`.

## Setup
Install one of: `pdftk`, `qpdf`, or `pdftotext` (from poppler).
