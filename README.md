# Multi-LLM Sidebar Extension

A Chrome extension that adds a sidebar workflow for sending prompts across multiple open LLM tabs.

## Overview

This project is a browser extension I built to make it easier to work with several LLMs at once.  
Instead of copying the same prompt manually between tabs, the extension is meant to help streamline that workflow through a sidebar and shared prompt controls.

The idea behind the project is simple: when comparing outputs, testing prompts, or using several AI tools in parallel, the browser itself should help manage the workflow.

## What It Does

- adds extension-based controls for prompt sending
- supports multi-tab LLM workflows
- uses a sidebar / popup based interaction model
- helps reduce repetitive copy-paste work across open AI tabs
- is designed as a practical productivity tool for day-to-day LLM use

## Current Status

This project is still a work in progress.  
The core idea and main extension structure are already implemented, but some site-specific flows and edge cases still need improvement.

## Why I Built It

I built this extension because I often work with multiple LLM tools in parallel and wanted a faster way to manage prompts across them.  
The goal was not just to make a simple browser extension, but to explore a practical AI workflow tool that solves a real everyday problem.

## Tech Stack

- JavaScript
- Chrome Extension APIs
- HTML / CSS
- Browser content scripts and background scripts

## Project Structure

- `manifest.json` – extension configuration
- `background.js` – background extension logic
- `content.js` – page interaction logic
- `page_wake.js` – page activity / wake handling
- `popup.html` – popup UI
- `popup.js` – popup logic

## Installation

1. Clone or download this repository.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable Developer Mode.
4. Click `Load unpacked`.
5. Select the project folder.

## Usage

After loading the extension in Chrome, open the supported LLM tabs and use the extension controls to manage prompt sending through the popup or sidebar workflow.

## What I Learned

This project helped me improve in:
- browser extension architecture
- working with content scripts and background scripts
- building practical automation tools
- designing workflows around real LLM usage
- debugging cross-page browser behavior

## Limitations

The project is still under active development, so some integrations are not fully polished yet and some site-specific behaviors may require further work.

## Roadmap

Planned improvements include:
- better reliability across different LLM websites
- cleaner sidebar UX
- more robust prompt routing
- better handling of tab states and edge cases

## Notes

This repository is meant as a practical software project showing my interest in AI tooling, automation, and real-world workflow design.
