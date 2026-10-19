# Archive comparison and popup implementation plan
> For agentic workers: use subagent-driven-development; each task owns independent files and its test cycle.
**Goal:** Zhao compares old/new extracted documents with persistent highlights and grounded summaries in a spacious two-column popup.
**Architecture:** Bounded deterministic block/inline diff, private immutable comparison storage, existing grounded chat with comparison context, archive-only layout.
**Tech stack:** Existing Node24/Fastify/PostgreSQL/React; no new packages.
**Spec:** docs/superpowers/specs/2026-10-17-archive-comparison-design.md

## Global constraints
Existing Zhao popup/theme only; no office animation changes. No GitHEAD; snapshots in .local/archive-comparison, no Git staging/commit/worktree. User authorized execution/localdeployment/modelacceptance; no repetitive permission gates. Source6MiB/200000chars/2000blocks/2000chars-per-block; diff blockmatrix<=2000x2000, inline globalcellbudget2000000, serializedresult<=6MiB. Model context<=32sources/24000chars, modifiedpairskeptwhole. Preserve originalbytes/extractions/conversations/Dragonrecords. All interfaces and exact shapes in spec are binding. Each implementer reads spec + ownbrief only; no subagents/fullregression/liveDB/modelcalls; root owns those.

## Review focus
- An insertion changes paragraph numbers without changing the later text: align by exacttext, not id/location (Task1).
- Long completely different paragraphs must stay bounded without silently losing text (Task1).
- Modified claims require both before/after evidence; stale or cross-owner comparisons fail closed (Task2).
- Selecting a new pair or tenant while an old request resolves must not display mislabeled results or overwrite draft (Task3).
- At actual878x669 desktop width the right log/input must be substantially larger and remain reachable without changing otheremployees (Task3).

### Task 1: deterministic text diff
Own/create apps/api/src/archive/compare.mjs; tests/archive-compare.test.mjs. Consume/produce exact compareDocumentText/ComparisonHunk contract in spec. No database/model/UI edits. Validate plain bounded source blocks before allocation; pure deterministic algorithm. Source warnings inresult can cover algorithmfallback; Task2 combines parserwarnings.
- [x] RED tests exactidentity, inserted/repeated paragraphs andstableties, added/removed/modified/reverse, Chinese/emoji/combiningcharacters/whitespace, segmentsreconstructbothsources, budgetfallbackretainsalltext, full2000blocklimits andoversize rejection.
- [x] Implement integer-token blockLCS and boundedgraphemeinlineLCS; alloutput sourceidentities/textlocations copied, no fabricatedcontent; controlled errorswithactionablemessage, resultbudgetcheck.
- [x] Focused `node --test tests/archive-compare.test.mjs`, selfreview; report .local/archive-comparison/task-1-report.md withRED/GREENandexactcontracts. Root scopedreviewlater.

### Task 2: private comparisons and grounded chat
Own/create apps/api/src/archive/comparison-store.mjs,comparison-routes.mjs,comparison-context.mjs,database/migrations/018_archive_comparisons.sql,tests/archive-comparisons.test.mjs. Modify archive/context.mjs,app.mjs,workspace-services.mjs only forintegration/guidance. Existing archive/store/parser remain unchangedunlessessentialandcoordinated. Consume purecomparemodule fromTask1 andexactAPI/specinterfaces. Returncomparisonfields withold/newversionsandfullresult; metadata-only list newest20. Registration app.mjs calls comparisonrouteswithscoped; persistedcontextloader suppliedtoexistingchat path. Extend existinggroundedvalidation with server-controlledclaimvalidation/sidefields, preserving existingdocanswers.
- [x] RED migratedPGlite actualupload/parsefixture tests for privatecreate/list/detail, samefile/unready/hashmismatch, nochange/direction/duplicateconcurrentcreation, immutablehistory/RLS/FK, DBtransactionsnotheldformodel/diff.
- [x] Implement migration/private loading/identitycheck/deduped immutable insert androutes. Validate originalhash on create/detail/context; shorttransactionread andwrite boundaries. Refuse oversizedoutputs and useAPIerrors; no secretsprinted.
- [x] RED comparisonchat tests genuinecitedchanges, bilateralmodifiedclaims, wrongold/newclaimsources/madeupquotes rejectedwithoutsave, partialcontextlabels, nochangezero-model, modelerrorleavescomparison, savedcomparisonrefs/citesandrevisionCAS. Implement through existingchatgateway/skills withcomparisonId mutualexclusion; no newprovider norautorefallback.
- [x] Focused `node --test tests/archive-comparisons.test.mjs tests/archive-context.test.mjs tests/archive-documents.test.mjs`; report .local/archive-comparison/task-2-report.md withRED/GREEN/migration/integrationnotes. Root fulltests/deploy.

### Task 3: popup comparison and right-side chat
Own/create apps/web/src/saas/ArchiveComparison.tsx,archive-comparisons.ts,archive-comparisons.css,apps/web/tests/archive-comparisons.test.mjs; modify ArchiveDocuments.tsx,DepartmentChat.tsx,EmployeeDialog.tsx,archive-documents.ts,ArchiveSources.tsx,archive-documents.css,employee-dialog.css,i18n/en.json,existingarchive-documents.test.mjs. No globalcss/officefiles. ConsumecomparisonAPIs/typesfromspec. Reuse existingArchiveDocuments upload/list/poll: passreadylist tocomparisonchild; explicitold/newselects independentofQAcheckboxes. No per-roleuploaderneeded: uploadtwoviaexistingcontrolthenchoose. Persist comparison IDs/history serverside; stale-safe load/request scopedtoorderedpairandtenant.
- [x] RED realbrowsertests ordering/samefile/identicalfilevalidity, inlineescape/highlight+location, unchangedtoggle+50pagination, modelsummaryevent+draftpreserve, pair/tenant stale request/history reopen, failedmodels leavesdiff. ExistingOCR/upload/citation testsretained.
- [x] Implement leftdocument+comparisonworkspace/rightchatlayout archive-only. Showimmediateoverview, fullboundedpaginateddiff, explicit总结改动 calls existingchatonce withcomparisonId whilepreservingdraft; activecomparisonbanner/退出比对问答; followupsuseID; savedmessages查看本次比对 callback. Use old/newcitationlabels.
- [x] EnlargeZhaopopupscopedmax1520x960, viewportmargins8-12px andcompactheader/nav. Desktop>=760 left/right; at878x669 log>=260px textarea>=130px; at1440x900 log>=380px textarea>=150px. Mobiletextarea>=110px accessiblecomposer; avoidoverflow. PreserveotheremployeeDOM/CSS andpurpleaccent. Updateoldlayoutassertionstomatchnewapproveddesign, neverweakenprivacy/racetests.
- [x] Focusedportable andopt-inEdge tests, web lint/build; report .local/archive-comparison/task-3-report.md withtestcommands/logs/screensizes andcontracts. Root actualbrowserverification.

### Task 4: root review and delivery
- [x] Snapshot touchedsources + DBoriginalrecords+fresh40officehashes; baselinefocusedtests.
- [x] Scopedreviews/fixes; fullrootregression/lint/build andfinalintegratedreview.
- [x] Applymigration018, grantexistingapp-roleprivilegesfornewtable asneeded; restartverifiedlocalapp only; syntheticold/newrealuploads and actualmodelsummary; savedcompare/quotesafterreload. Confirmhashes/records andsaveactualUI screenshot.
- [x] Completeledger/plan anddeliver useinstructions pluslimits. NoGitcommit/push.

