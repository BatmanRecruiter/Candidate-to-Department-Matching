# Portfolio Entry: phData Candidate Department Matching

## Project card

**phData Candidate Department Matching**
AI-powered recruiting triage tool that routes candidate LinkedIn exports to the correct phData department using Claude LLM reasoning, recruiter calibration feedback, and cost-optimized batch processing.

## Short description

Built a full-stack recruiting operations tool for phData. Recruiters upload a CSV of LinkedIn candidate data; the app scores each candidate against phData's eight service departments using Claude Sonnet 4.6, returns a confidence-scored export with department fit and rationale, and learns from recruiter corrections over time. Designed for scale: supports real-time scoring and async Anthropic Batch API processing at 50% token cost.

## Portfolio case study

### Problem

Recruiting teams reviewing hundreds of candidates across eight technical departments (Data Engineering, Analytics, Machine Learning, Advisory, Business Architecture, Managed Services, PMO, Sales) had no systematic triage layer. Without automated routing, multiple recruiters reviewed the same broad candidate pool, producing duplicated effort, inconsistent department assignments, and slow handoffs.

### Solution

A browser-based tool that accepts a LinkedIn-style CSV export, runs each candidate through a Claude Sonnet 4.6 LLM matcher, and outputs a template-aligned export with department fit, confidence level, and plain-English rationale. The system improves over time through a pattern-learning calibration loop: recruiter corrections are stored and injected as few-shot examples into every subsequent match call, so the model's failure modes are progressively corrected without prompt rewrites.

### Key features

- **LLM-based department routing** via Claude Sonnet 4.6 with a detailed system prompt encoding eight department profiles, a "what they DO, not just tools" evaluation principle, and 3× recency weighting for recent roles
- **Prompt caching** on the stable system prompt block, reducing input token costs ~70% across batch runs
- **Hard-block regex layer** that eliminates clearly out-of-scope profiles (investment banking, cybersecurity, ERP implementation, etc.) before hitting the LLM
- **Pattern-learning calibration**: recruiter corrections stored in PostgreSQL and injected as few-shot examples into every match call — the model learns from past misroutes automatically
- **Tipping point analysis**: at 50 corrections, Claude generates a synthesis of systemic misrouting patterns with specific prompt boundary update recommendations, delivered via Slack
- **Binary confidence scoring**: 2 (confident, route without review) or 1 (low confidence, recruiter should review), plus N/A and ? for edge cases
- **Real-time and batch processing**: real-time mode scores 5 candidates concurrently with live progress; batch mode submits to Anthropic Batch API (50% cost reduction) with 30-second auto-polling and Slack notification on completion
- **Admin panel**: shared upload/export history, calibration feedback log, live Greenhouse role sync, calibration intelligence panel with progress toward tipping point
- **Keyboard-driven review UI**: J/K navigate, C mark correct, F fix, N next unreviewed

### Tech stack

React, TypeScript, Vite, Express, Neon (PostgreSQL), Drizzle ORM, Tailwind CSS, shadcn/ui, PapaParse, Anthropic SDK (Claude Sonnet 4.6). Deployed on Render.

### Outcome

Turns a manual, multi-recruiter spreadsheet triage process into a repeatable upload → score → export workflow. The calibration loop means accuracy improves with each use cycle without requiring prompt engineering expertise from the recruiting team. Batch mode makes large-scale candidate runs ($0.016 per candidate with caching) economically practical for regular pipeline reviews.

## One-line resume bullet

Built a TypeScript/React recruiting triage platform using Claude Sonnet 4.6 to route LinkedIn candidate exports to phData departments, with prompt caching, pattern-learning calibration feedback, and Anthropic Batch API integration for cost-optimized large-scale runs.
