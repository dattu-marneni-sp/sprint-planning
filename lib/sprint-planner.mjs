/**
 * Sprint Planner - Prioritizes tasks and generates a sprint plan
 * Uses velocity, capacity, commitments, and backlog data to produce
 * an actionable sprint plan.
 */

const PRIORITY_SCORES = {
  'Highest': 5,
  'High': 4,
  'Medium': 3,
  'Low': 2,
  'Lowest': 1
};

const STATUS_WEIGHT = {
  'In Progress': 3,     // carry-over, already started
  'In Review': 2.5,     // almost done
  'To Do': 1,           // not started
  'Backlog': 0.5        // not even planned
};

export class SprintPlanner {
  constructor() {
    this.maxTicketsPerPerson = 6;
  }

  /**
   * Score and rank tickets for sprint inclusion
   */
  scoreTickets(tickets, carryOver, commitments) {
    const scored = [];
    const commitmentKeywords = commitments
      .map(c => c.text.toLowerCase().split(/\s+/))
      .flat()
      .filter(w => w.length > 3);

    for (const ticket of tickets) {
      let score = 0;

      // Priority score (0-5)
      score += PRIORITY_SCORES[ticket.priority] || 2;

      // Status score - in-progress items get highest priority
      score += STATUS_WEIGHT[ticket.status] || 1;

      // Carry-over bonus: items that were in previous sprint get +3
      const isCarryOver = carryOver.some(co => co.key === ticket.key);
      if (isCarryOver) score += 3;

      // Commitment alignment: if ticket matches Confluence commitments, +2
      const summaryLower = (ticket.summary || '').toLowerCase();
      const matchesCommitment = commitmentKeywords.some(kw => summaryLower.includes(kw));
      if (matchesCommitment) score += 2;

      // Bug priority boost
      if (ticket.type === 'Bug') score += 1.5;

      // Story points factor (larger items need more attention)
      const points = ticket.storyPoints || 0;
      if (points > 0) score += Math.min(points / 3, 2);

      scored.push({
        ...ticket,
        score: Math.round(score * 10) / 10,
        isCarryOver,
        matchesCommitment,
        storyPoints: points
      });
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  /**
   * Generate the sprint plan with assignments
   */
  generateSprintPlan(scoredTickets, capacity, velocity) {
    const plan = {
      sprintGoal: '',
      totalTickets: 0,
      totalPoints: 0,
      assignments: {},
      unassigned: [],
      overflow: [],
      sections: {
        carryOver: [],
        committed: [],
        newWork: [],
        stretch: []
      }
    };

    // Determine capacity-based ticket limit
    const maxTickets = Math.min(
      scoredTickets.length,
      Math.round(Object.values(velocity).reduce((s, v) => s + v.avgTicketsPerSprint, 0) * 1.1)
    );

    // Initialize assignments per member
    for (const member of capacity.members) {
      if (!member.isOOO) {
        plan.assignments[member.name] = {
          tickets: [],
          totalPoints: 0,
          capacity: member.estimatedCapacity
        };
      }
    }

    let ticketCount = 0;

    for (const ticket of scoredTickets) {
      // Categorize
      if (ticket.isCarryOver) {
        plan.sections.carryOver.push(ticket);
      } else if (ticket.matchesCommitment) {
        plan.sections.committed.push(ticket);
      } else if (ticketCount < maxTickets) {
        plan.sections.newWork.push(ticket);
      } else {
        plan.sections.stretch.push(ticket);
        continue;
      }

      // Try to assign to least loaded team member
      if (ticket.assignee && ticket.assignee !== 'Unassigned' && plan.assignments[ticket.assignee]) {
        const member = plan.assignments[ticket.assignee];
        if (member.tickets.length < this.maxTicketsPerPerson) {
          member.tickets.push(ticket);
          member.totalPoints += ticket.storyPoints || 0;
        } else {
          plan.overflow.push(ticket);
        }
      } else {
        // Assign to least loaded available member
        const available = Object.entries(plan.assignments)
          .filter(([_, m]) => m.tickets.length < this.maxTicketsPerPerson)
          .sort((a, b) => a[1].tickets.length - b[1].tickets.length);

        if (available.length > 0) {
          const [name, member] = available[0];
          member.tickets.push(ticket);
          member.totalPoints += ticket.storyPoints || 0;
        } else {
          plan.unassigned.push(ticket);
        }
      }

      ticketCount++;
      plan.totalTickets = ticketCount;
      plan.totalPoints += ticket.storyPoints || 0;
    }

    // Generate sprint goal from top commitments and carry-overs
    const goals = [];
    if (plan.sections.carryOver.length > 0) {
      goals.push(`Complete ${plan.sections.carryOver.length} carry-over items`);
    }
    if (plan.sections.committed.length > 0) {
      goals.push(`Deliver ${plan.sections.committed.length} committed items`);
    }
    goals.push(`Execute ${plan.sections.newWork.length} new tasks`);
    plan.sprintGoal = goals.join('; ');

    return plan;
  }

  /**
   * Format the sprint plan as a markdown report
   */
  formatPlanAsMarkdown(plan, velocity, capacity) {
    const lines = [];
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const sprintStart = new Date(now);
    // Next Monday
    sprintStart.setDate(sprintStart.getDate() + ((1 + 7 - sprintStart.getDay()) % 7 || 7));
    const sprintEnd = new Date(sprintStart);
    sprintEnd.setDate(sprintEnd.getDate() + 13);

    const fmtDate = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    lines.push(`# Sprint Plan`);
    lines.push(`**Generated:** ${dateStr}`);
    lines.push(`**Sprint Period:** ${fmtDate(sprintStart)} - ${fmtDate(sprintEnd)}`);
    lines.push('');

    // Sprint Goal
    lines.push(`## Sprint Goal`);
    lines.push(plan.sprintGoal);
    lines.push('');

    // Executive Summary
    lines.push(`## Executive Summary`);
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Total Tickets | ${plan.totalTickets} |`);
    lines.push(`| Total Story Points | ${plan.totalPoints} |`);
    lines.push(`| Team Members Available | ${capacity.totalMembers - capacity.oooMembers.length} / ${capacity.totalMembers} |`);
    lines.push(`| Carry-Over Items | ${plan.sections.carryOver.length} |`);
    lines.push(`| Committed Items | ${plan.sections.committed.length} |`);
    lines.push(`| New Work | ${plan.sections.newWork.length} |`);
    lines.push(`| Stretch Goals | ${plan.sections.stretch.length} |`);
    lines.push('');

    // Team Velocity
    lines.push(`## Team Velocity`);
    lines.push(`| Project | Avg Tickets/Sprint | Avg Points/Sprint | Trend |`);
    lines.push(`|---------|-------------------|-------------------|-------|`);
    for (const [project, v] of Object.entries(velocity)) {
      const trendIcon = v.trend === 'improving' ? 'UP' : v.trend === 'declining' ? 'DOWN' : 'STABLE';
      lines.push(`| ${project} | ${v.avgTicketsPerSprint} | ${v.avgPointsPerSprint} | ${trendIcon} |`);
    }
    lines.push('');

    // Team Capacity
    lines.push(`## Team Capacity`);
    if (capacity.oooMembers.length > 0) {
      lines.push(`**OOO Members:** ${capacity.oooMembers.join(', ')}`);
      lines.push('');
    }
    lines.push(`| Member | Projects | Current Load | Capacity | Status |`);
    lines.push(`|--------|----------|-------------|----------|--------|`);
    for (const m of capacity.members) {
      const status = m.isOOO ? 'OOO' : 'Available';
      lines.push(`| ${m.name} | ${m.projects.join(', ')} | ${m.currentTickets} tickets | ${m.estimatedCapacity} pts | ${status} |`);
    }
    lines.push('');

    // Carry-Over Items
    if (plan.sections.carryOver.length > 0) {
      lines.push(`## Carry-Over Items (Must Complete)`);
      lines.push(`These items are rolling over from the previous sprint and should be prioritized.`);
      lines.push('');
      this._renderTicketTable(lines, plan.sections.carryOver);
      lines.push('');
    }

    // Committed Items
    if (plan.sections.committed.length > 0) {
      lines.push(`## Committed Items (Aligned with Confluence Commitments)`);
      lines.push(`These items match team commitments documented in Confluence.`);
      lines.push('');
      this._renderTicketTable(lines, plan.sections.committed);
      lines.push('');
    }

    // New Work
    if (plan.sections.newWork.length > 0) {
      lines.push(`## New Work`);
      lines.push(`New items prioritized for this sprint based on score.`);
      lines.push('');
      this._renderTicketTable(lines, plan.sections.newWork);
      lines.push('');
    }

    // Sprint Assignments
    lines.push(`## Sprint Assignments`);
    for (const [name, assignment] of Object.entries(plan.assignments)) {
      lines.push(`### ${name}`);
      lines.push(`**Assigned:** ${assignment.tickets.length} tickets | **Points:** ${assignment.totalPoints} / ${assignment.capacity}`);
      if (assignment.tickets.length > 0) {
        lines.push('');
        lines.push(`| Ticket | Summary | Priority | Points | Score |`);
        lines.push(`|--------|---------|----------|--------|-------|`);
        for (const t of assignment.tickets) {
          lines.push(`| ${t.key} | ${(t.summary || '').substring(0, 60)} | ${t.priority || '-'} | ${t.storyPoints || '-'} | ${t.score} |`);
        }
      } else {
        lines.push('*No tickets assigned yet*');
      }
      lines.push('');
    }

    // Stretch Goals
    if (plan.sections.stretch.length > 0) {
      lines.push(`## Stretch Goals (If Capacity Allows)`);
      this._renderTicketTable(lines, plan.sections.stretch.slice(0, 10));
      lines.push('');
    }

    // Unassigned / Overflow
    if (plan.unassigned.length > 0 || plan.overflow.length > 0) {
      lines.push(`## Unassigned / Overflow`);
      lines.push(`These items need manual assignment or should be moved to the next sprint.`);
      lines.push('');
      this._renderTicketTable(lines, [...plan.unassigned, ...plan.overflow]);
      lines.push('');
    }

    // Risks
    lines.push(`## Risks & Notes`);
    if (capacity.oooMembers.length > 0) {
      lines.push(`- **Reduced Capacity:** ${capacity.oooMembers.length} team member(s) OOO`);
    }
    if (plan.sections.carryOver.length > 3) {
      lines.push(`- **High Carry-Over:** ${plan.sections.carryOver.length} items rolling over indicates possible under-estimation`);
    }
    for (const [project, v] of Object.entries(velocity)) {
      if (v.trend === 'declining') {
        lines.push(`- **Declining Velocity in ${project}:** Investigate blockers or scope creep`);
      }
    }
    if (plan.overflow.length > 0) {
      lines.push(`- **Overflow:** ${plan.overflow.length} items could not be assigned due to capacity limits`);
    }
    lines.push('');

    lines.push('---');
    lines.push(`*Generated by Sprint Planner v1.0*`);

    return lines.join('\n');
  }

  _renderTicketTable(lines, tickets) {
    lines.push(`| # | Ticket | Summary | Type | Priority | Points | Score |`);
    lines.push(`|---|--------|---------|------|----------|--------|-------|`);
    tickets.forEach((t, i) => {
      lines.push(`| ${i + 1} | ${t.key} | ${(t.summary || '').substring(0, 55)} | ${t.type || '-'} | ${t.priority || '-'} | ${t.storyPoints || '-'} | ${t.score} |`);
    });
  }
}
