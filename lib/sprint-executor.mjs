/**
 * Sprint Executor - Executes a sprint plan by creating/updating Jira tickets
 *
 * Capabilities:
 *   - Create new Jira tickets from the plan
 *   - Assign tickets to team members
 *   - Move existing tickets into the active sprint
 *   - Transition ticket statuses (e.g. Backlog → To Do)
 */

export class SprintExecutor {
  constructor(mcpClient, cloudId) {
    this.mcp = mcpClient;
    this.cloudId = cloudId;
    this.accountIdCache = new Map();
    this.results = { assigned: [], moved: [], created: [], transitioned: [], errors: [] };
  }

  /**
   * Execute the full sprint plan
   * @param {object} plan - The generated sprint plan
   * @param {object} options - Execution options
   * @param {boolean} options.assign - Assign tickets to members
   * @param {boolean} options.createNew - Create new tickets from plan
   * @param {boolean} options.transition - Transition ticket statuses
   * @param {boolean} options.dryRun - Log actions without executing
   */
  async execute(plan, options = {}) {
    const { assign = true, createNew = false, transition = false, dryRun = false } = options;

    this._log(`\nStarting sprint execution${dryRun ? ' (DRY RUN)' : ''}...`);

    // Step 1: Resolve team member account IDs
    if (assign) {
      this._log('\n[Exec 1] Resolving team member account IDs...');
      await this._resolveAccountIds(Object.keys(plan.assignments));
    }

    // Step 2: Assign tickets to team members
    if (assign) {
      this._log('\n[Exec 2] Assigning tickets to team members...');
      for (const [memberName, assignment] of Object.entries(plan.assignments)) {
        const accountId = this.accountIdCache.get(memberName);
        if (!accountId) {
          this._log(`  SKIP: No account ID found for ${memberName}`);
          continue;
        }

        for (const ticket of assignment.tickets) {
          if (ticket.assignee === memberName) {
            this._log(`  SKIP: ${ticket.key} already assigned to ${memberName}`);
            continue;
          }

          if (dryRun) {
            this._log(`  DRY RUN: Would assign ${ticket.key} to ${memberName}`);
            this.results.assigned.push({ key: ticket.key, assignee: memberName, dryRun: true });
            continue;
          }

          try {
            await this._assignTicket(ticket.key, accountId);
            this._log(`  OK: Assigned ${ticket.key} → ${memberName}`);
            this.results.assigned.push({ key: ticket.key, assignee: memberName });
          } catch (e) {
            this._log(`  ERROR: Failed to assign ${ticket.key}: ${e.message}`);
            this.results.errors.push({ action: 'assign', key: ticket.key, error: e.message });
          }
        }
      }
    }

    // Step 3: Transition tickets to "To Do" if they are in Backlog
    if (transition) {
      this._log('\n[Exec 3] Transitioning ticket statuses...');
      const allTickets = this._collectAllTickets(plan);

      for (const ticket of allTickets) {
        if (ticket.status && ticket.status.toLowerCase() === 'backlog') {
          if (dryRun) {
            this._log(`  DRY RUN: Would transition ${ticket.key} from Backlog → To Do`);
            this.results.transitioned.push({ key: ticket.key, from: 'Backlog', to: 'To Do', dryRun: true });
            continue;
          }

          try {
            await this._transitionToToDo(ticket.key);
            this._log(`  OK: Transitioned ${ticket.key} → To Do`);
            this.results.transitioned.push({ key: ticket.key, from: 'Backlog', to: 'To Do' });
          } catch (e) {
            this._log(`  ERROR: Failed to transition ${ticket.key}: ${e.message}`);
            this.results.errors.push({ action: 'transition', key: ticket.key, error: e.message });
          }
        }
      }
    }

    // Step 4: Create new tickets from unassigned/overflow items
    if (createNew && plan.unassigned && plan.unassigned.length > 0) {
      this._log('\n[Exec 4] Creating new tickets for unassigned items...');
      for (const item of plan.unassigned) {
        if (item.key) {
          this._log(`  SKIP: ${item.key} already exists in Jira`);
          continue;
        }

        if (!item.summary) {
          this._log(`  SKIP: No summary for item`);
          continue;
        }

        const projectKey = item.project || 'DATAG';

        if (dryRun) {
          this._log(`  DRY RUN: Would create ticket in ${projectKey}: ${item.summary}`);
          this.results.created.push({ project: projectKey, summary: item.summary, dryRun: true });
          continue;
        }

        try {
          const result = await this._createTicket(projectKey, item.summary, item.type || 'Story', item.description || '');
          const newKey = this._extractNewKey(result);
          this._log(`  OK: Created ${newKey || 'ticket'} in ${projectKey}: ${item.summary.substring(0, 50)}`);
          this.results.created.push({ project: projectKey, summary: item.summary, key: newKey });
        } catch (e) {
          this._log(`  ERROR: Failed to create ticket: ${e.message}`);
          this.results.errors.push({ action: 'create', summary: item.summary, error: e.message });
        }
      }
    }

    // Summary
    this._log('\n' + '='.repeat(50));
    this._log('  EXECUTION SUMMARY');
    this._log('='.repeat(50));
    this._log(`  Tickets assigned:    ${this.results.assigned.length}`);
    this._log(`  Tickets transitioned: ${this.results.transitioned.length}`);
    this._log(`  Tickets created:     ${this.results.created.length}`);
    this._log(`  Errors:              ${this.results.errors.length}`);
    if (dryRun) {
      this._log('  Mode: DRY RUN (no changes made)');
    }
    this._log('');

    return this.results;
  }

  /**
   * Resolve display names to Jira account IDs
   */
  async _resolveAccountIds(memberNames) {
    for (const name of memberNames) {
      if (this.accountIdCache.has(name)) continue;

      try {
        const result = await this.mcp.call('lookupJiraAccountId', {
          cloudId: this.cloudId,
          searchString: name
        });
        const data = this.mcp.extractJSON(result);

        let accountId = null;
        if (Array.isArray(data) && data.length > 0) {
          accountId = data[0].accountId;
        } else if (typeof data === 'string') {
          // Try to extract account ID from text response
          const match = data.match(/accountId[:\s]+"?([a-zA-Z0-9:_-]+)"?/);
          if (match) accountId = match[1];
          // Also try extracting from a simpler format
          const idMatch = data.match(/([0-9a-f]{24}|[0-9]+:[0-9a-f-]+)/);
          if (!accountId && idMatch) accountId = idMatch[1];
        } else if (data && data.accountId) {
          accountId = data.accountId;
        }

        if (accountId) {
          this.accountIdCache.set(name, accountId);
          this._log(`  Resolved: ${name} → ${accountId}`);
        } else {
          this._log(`  WARN: Could not resolve account ID for ${name}`);
        }
      } catch (e) {
        this._log(`  ERROR resolving ${name}: ${e.message}`);
      }
    }
  }

  /**
   * Assign a ticket to a user by account ID
   */
  async _assignTicket(issueKey, accountId) {
    return await this.mcp.call('editJiraIssue', {
      cloudId: this.cloudId,
      issueIdOrKey: issueKey,
      fields: {
        assignee: { accountId }
      }
    });
  }

  /**
   * Create a new Jira ticket
   */
  async _createTicket(projectKey, summary, issueType = 'Story', description = '') {
    const args = {
      cloudId: this.cloudId,
      projectKey,
      issueTypeName: issueType,
      summary
    };
    if (description) args.description = description;
    return await this.mcp.call('createJiraIssue', args);
  }

  /**
   * Transition a ticket to "To Do" status
   */
  async _transitionToToDo(issueKey) {
    // First get available transitions
    const transResult = await this.mcp.call('getTransitionsForJiraIssue', {
      cloudId: this.cloudId,
      issueIdOrKey: issueKey
    });
    const transData = this.mcp.extractJSON(transResult);

    let todoTransitionId = null;

    if (transData && transData.transitions) {
      for (const t of transData.transitions) {
        if (t.name && (t.name.toLowerCase() === 'to do' || t.name.toLowerCase() === 'todo' || t.name.toLowerCase() === 'open')) {
          todoTransitionId = t.id;
          break;
        }
      }
    } else if (typeof transData === 'string') {
      const match = transData.match(/(?:To\s*Do|Todo|Open)\D+?(?:id[:\s]+"?)(\d+)/i);
      if (match) todoTransitionId = match[1];
    }

    if (!todoTransitionId) {
      throw new Error(`No "To Do" transition available for ${issueKey}`);
    }

    return await this.mcp.call('transitionJiraIssue', {
      cloudId: this.cloudId,
      issueIdOrKey: issueKey,
      transition: { id: todoTransitionId }
    });
  }

  /**
   * Extract the new issue key from a create response
   */
  _extractNewKey(result) {
    if (!result) return null;
    const text = this.mcp.extractText(result);
    if (text) {
      const match = text.match(/([A-Z]+-\d+)/);
      if (match) return match[1];
      try {
        const json = JSON.parse(text);
        return json.key || null;
      } catch {}
    }
    const json = this.mcp.extractJSON(result);
    if (json && json.key) return json.key;
    return null;
  }

  /**
   * Collect all tickets from plan sections
   */
  _collectAllTickets(plan) {
    const all = [];
    for (const section of ['carryOver', 'committed', 'newWork']) {
      if (plan.sections[section]) {
        all.push(...plan.sections[section]);
      }
    }
    return all;
  }

  /**
   * Generate execution report as markdown
   */
  generateReport() {
    const lines = [];
    lines.push('# Sprint Execution Report');
    lines.push(`**Executed:** ${new Date().toLocaleString()}`);
    lines.push('');

    if (this.results.assigned.length > 0) {
      lines.push('## Ticket Assignments');
      lines.push('| Ticket | Assigned To | Status |');
      lines.push('|--------|-------------|--------|');
      for (const r of this.results.assigned) {
        const status = r.dryRun ? 'DRY RUN' : 'Done';
        lines.push(`| ${r.key} | ${r.assignee} | ${status} |`);
      }
      lines.push('');
    }

    if (this.results.transitioned.length > 0) {
      lines.push('## Status Transitions');
      lines.push('| Ticket | From | To | Status |');
      lines.push('|--------|------|-----|--------|');
      for (const r of this.results.transitioned) {
        const status = r.dryRun ? 'DRY RUN' : 'Done';
        lines.push(`| ${r.key} | ${r.from} | ${r.to} | ${status} |`);
      }
      lines.push('');
    }

    if (this.results.created.length > 0) {
      lines.push('## Tickets Created');
      lines.push('| Key | Project | Summary | Status |');
      lines.push('|-----|---------|---------|--------|');
      for (const r of this.results.created) {
        const status = r.dryRun ? 'DRY RUN' : 'Created';
        lines.push(`| ${r.key || '-'} | ${r.project} | ${r.summary.substring(0, 50)} | ${status} |`);
      }
      lines.push('');
    }

    if (this.results.errors.length > 0) {
      lines.push('## Errors');
      lines.push('| Action | Ticket | Error |');
      lines.push('|--------|--------|-------|');
      for (const r of this.results.errors) {
        lines.push(`| ${r.action} | ${r.key || r.summary || '-'} | ${r.error.substring(0, 60)} |`);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push('*Generated by Sprint Executor v1.0*');
    return lines.join('\n');
  }

  _log(msg) {
    process.stderr.write(`${msg}\n`);
  }
}
