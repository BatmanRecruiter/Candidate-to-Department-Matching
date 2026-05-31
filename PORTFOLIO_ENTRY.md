# Portfolio Entry: phData Candidate Department Matching

## Project card

**phData Candidate Department Matching**  
AI-assisted recruiting workflow tool that routes candidate LinkedIn exports to the right phData recruiting team by comparing each profile against live role requirements, location constraints, seniority expectations, and required skill groups.

## Short description

Built a browser-based matching engine for recruiting operations. The app ingests a CSV of LinkedIn-style candidate data, compares each candidate against an embedded library of phData job descriptions, and exports a template-aligned CSV with department fit, role fit, rationale, and confidence. The goal is to reduce the manual triage burden across department-aligned recruiters while avoiding loose or overconfident matches.

## Portfolio case study

### Problem

Recruiters needed to review hundreds of candidate profiles across many departments and open roles. Without automated triage, multiple recruiters could end up reviewing the same broad candidate pool, creating duplicated effort and slower routing.

### Solution

I built a full-stack web app that processes candidate CSVs directly in the browser, applies deterministic role-matching logic, and produces a recruiter-ready export. The matcher evaluates department, role title, required skills, location, years of experience, and seniority level. If a profile does not meet a role's requirements, the app can still route the candidate to the most likely department while leaving the role as uncertain.

### Key features

- CSV upload and downloadable template-aligned export
- Strict role gates for skills, geography, YOE, and seniority
- Department-level routing when role-level confidence is insufficient
- Confidence scoring from 1 to 3 with recruiter-facing rationale
- Saved upload/export history protected by a private history key
- phData-inspired light UI with role library summaries

### Tech stack

React, TypeScript, Vite, Express, SQLite, Drizzle ORM, Tailwind CSS, shadcn/ui, PapaParse.

### Outcome

The tool helps department-aligned recruiters focus on the profiles most relevant to their open roles instead of having every recruiter review the same full candidate list. It turns a manual spreadsheet triage process into a repeatable upload, score, and export workflow.

## One-line resume bullet

Built a TypeScript/React recruiting matching engine that maps LinkedIn candidate exports to department and role fits using strict job requirement, location, YOE, and seniority gates.
