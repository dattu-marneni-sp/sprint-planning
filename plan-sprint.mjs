#!/usr/bin/env node
/**
 * Sprint Planning CLI
 *
 * Usage: node plan-sprint.mjs
 * Trigger: "help me plan this sprint"
 *
 * Steps:
 *   1. Fetch current project status, commitments from Jira and Confluence
 *   2. Analyze team velocity and capacity
 *   3. Suggest task prioritization
 *   Result: Fully planned sprint with tasks created
 *
 * Boards covered:
 *   - DATAG  (board 2525)
 *   - SAASD8NG (board 1082)
 *   - SAASFD (board 2565)
 */

import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { MCPClient } from './lib/mcp-client.mjs';
import { JiraFetcher } from './lib/jira-fetcher.mjs';
import { ConfluenceFetcher } from './lib/confluence-fetcher.mjs';
import { VelocityAnalyzer } from './lib/velocity-analyzer.mjs';
import { SprintPlanner } from './lib/sprint-planner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = __dirname;
const PLAN_FILE = join(OUTPUT_DIR, 'sprint-plan.md');

function log(msg) {
  process.stderr.write(`${msg}\n`);
}

function logPhase(phase, msg) {
  const bar = '='.repeat(60);
  log('');
  log(bar);
  log(`  PHASE ${phase}: ${msg}`);
  log(bar);
}

async function main() {
  const startTime = Date.now();

  log('');
  log('  ============================================');
  log('  |      SPRINT PLANNING ASSISTANT v1.0      |');
  log('  |   "help me plan this sprint"             |');
  log('  ============================================');
  log('');

  // ── PHASE 0: Connect to Atlassian ──
  logPhase(0, 'Connecting to Atlassian MCP');
  const mcp = new MCPClient();
  await mcp.connect();
  log('  Connected to Atlassian MCP.');

  const jira = await JiraFetcher.create(mcp);
  const cloudId = jira.cloudId;
  const confluence = new ConfluenceFetcher(mcp, cloudId);
  log(`  Cloud ID: ${cloudId}`);

  try {
    // ── PHASE 1: Fetch Current Project Status ──
    logPhase(1, 'Fetching Current Project Status from Jira & Confluence');

    log('\n[1a] Active sprint tickets...');
    const activeTickets = await jira.fetchActiveSprintTickets();

    log('\n[1b] Backlog items...');
    const backlog = await jira.fetchBacklog();

    log('\n[1c] Carry-over items...');
    const carryOver = await jira.fetchCarryOver();

    log('\n[1d] Team members...');
    const teamMembers = await jira.fetchTeamMembers();
    log(`  Found ${teamMembers.length} team members`);

    log('\n[1e] Completed sprints (velocity data)...');
    const completedSprints = await jira.fetchCompletedSprintData(3);

    log('\n[1f] Confluence commitments...');
    const commitmentPages = await confluence.fetchTeamCommitments();

    log('\n[1g] Team availability (OOO)...');
    const availabilityInfo = await confluence.fetchAvailabilityInfo();

    // Enrich active sprint tickets with assignee data from getJiraIssue
    log('\n[1h] Enriching ticket details (fetching assignees)...');

    // Collect all search-result tickets as base data
    const allActiveBase = [];
    for (const [project, tickets] of Object.entries(activeTickets)) {
      for (const t of tickets.slice(0, 30)) {
        allActiveBase.push({ ...t, project });
      }
    }
    const allBacklogBase = [];
    for (const [project, tickets] of Object.entries(backlog)) {
      for (const t of tickets.slice(0, 15)) {
        allBacklogBase.push({ ...t, project });
      }
    }

    // Fetch individual ticket details (for assignee), merging with search base data
    const activeKeys = allActiveBase.map(t => t.key).slice(0, 50);
    const backlogKeys = allBacklogBase.map(t => t.key).slice(0, 30);

    const detailedActive = await jira.fetchTicketDetails(activeKeys, allActiveBase);
    const detailedBacklog = await jira.fetchTicketDetails(backlogKeys, allBacklogBase);

    log(`  Enriched ${detailedActive.length} active + ${detailedBacklog.length} backlog tickets`);
    const withAssignee = detailedActive.filter(t => t.assignee && t.assignee !== 'Unassigned');
    log(`  Tickets with assignees: ${withAssignee.length}`);

    // ── PHASE 2: Analyze Velocity & Capacity ──
    logPhase(2, 'Analyzing Team Velocity & Capacity');

    const analyzer = new VelocityAnalyzer();

    log('\n[2a] Calculating velocity...');
    const velocity = analyzer.calculateVelocity(completedSprints);
    for (const [project, v] of Object.entries(velocity)) {
      log(`  ${project}: ${v.avgTicketsPerSprint} tickets/sprint (${v.trend})`);
    }

    log('\n[2b] Assessing capacity...');
    const capacity = analyzer.assessCapacity(teamMembers, availabilityInfo);
    log(`  Total capacity: ${capacity.totalCapacity} points`);
    log(`  Available: ${capacity.totalMembers - capacity.oooMembers.length}/${capacity.totalMembers} members`);
    if (capacity.oooMembers.length > 0) {
      log(`  OOO: ${capacity.oooMembers.join(', ')}`);
    }

    log('\n[2c] Generating capacity summary...');
    const capacitySummary = analyzer.generateCapacitySummary(velocity, capacity);
    log(`  Recommendation: ${capacitySummary.recommendation}`);

    // ── PHASE 3: Prioritize Tasks & Generate Sprint Plan ──
    logPhase(3, 'Prioritizing Tasks & Generating Sprint Plan');

    const planner = new SprintPlanner();

    // Combine all tickets
    const allTickets = [...detailedActive, ...detailedBacklog].filter(t => t.key);

    // Flatten carry-over
    const allCarryOver = [];
    for (const [_, tickets] of Object.entries(carryOver)) {
      allCarryOver.push(...tickets);
    }

    // Parse commitments from Confluence
    const allCommitments = [];
    for (const page of commitmentPages) {
      if (page.content) {
        allCommitments.push(...confluence.parseCommitmentsText(page.content));
      }
    }
    log(`  Found ${allCommitments.length} commitments from Confluence`);

    log('\n[3a] Scoring and ranking tickets...');
    const scoredTickets = planner.scoreTickets(allTickets, allCarryOver, allCommitments);
    log(`  Scored ${scoredTickets.length} tickets`);

    log('\n[3b] Generating sprint plan...');
    const plan = planner.generateSprintPlan(scoredTickets, capacity, velocity);
    log(`  Sprint goal: ${plan.sprintGoal}`);
    log(`  Planned: ${plan.totalTickets} tickets, ${plan.totalPoints} points`);

    log('\n[3c] Formatting plan...');
    const markdown = planner.formatPlanAsMarkdown(plan, velocity, capacity);

    // ── PHASE 4: Save Results ──
    logPhase(4, 'Saving Sprint Plan');
    writeFileSync(PLAN_FILE, markdown, 'utf-8');
    log(`  Sprint plan saved to: ${PLAN_FILE}`);

    // Output the plan to stdout
    process.stdout.write(markdown);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log('');
    log('  ============================================');
    log(`  |  SPRINT PLANNING COMPLETE (${elapsed}s)        |`);
    log('  ============================================');
    log('');

  } catch (err) {
    log(`\nError: ${err.message}`);
    log(err.stack);
    process.exit(1);
  } finally {
    mcp.disconnect();
  }
}

main();
