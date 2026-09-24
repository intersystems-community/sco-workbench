import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PageHeaderComponent } from '../shared/page-header';

interface Example {
  icon: string;
  title: string;
  sop: string;
  result: string;
}

interface Step {
  title: string;
  desc: string;
}

interface Concept {
  icon: string;
  title: string;
  desc: string;
}

interface DocLink {
  title: string;
  sub: string;
  url: string;
}

const DOCS = 'https://docs.intersystems.com/supplychain20261/csp/docbook/DocBook.UI.Page.cls';

// Trigger types per the productions overview (EGIN_intro): business services receive
// input from outside through adapters and can poll on an interval.
const TRIGGERS: Concept[] = [
  {
    icon: '📂',
    title: 'Data arrives',
    desc: 'A new file lands in a folder, SFTP/FTP server, or S3 bucket, or new rows appear in a database.',
  },
  {
    icon: '🔌',
    title: 'Another system calls in',
    desc: 'An ERP, WMS, carrier, or supplier portal sends a message or calls an API.',
  },
  {
    icon: '⏰',
    title: 'On a schedule',
    desc: 'A service checks for new input at a set interval, such as every 5 minutes or every night.',
  },
  {
    icon: '🚨',
    title: 'Something happens in SCO',
    desc: 'A KPI flags a problem and raises an issue, or another business process hands off work.',
  },
];

const WORKFLOWS: Concept[] = [
  {
    icon: '🧾',
    title: 'Order intake',
    desc: 'A customer order file arrives. Validate it, add customer and product details, and send it to the ERP.',
  },
  {
    icon: '🚢',
    title: 'Advance ship notices',
    desc: 'A supplier sends a ship notice. Update expected receipts and alert the buyer if the quantity is short.',
  },
  {
    icon: '🔄',
    title: 'Nightly replenishment',
    desc: 'Each night, compare stock to safety levels and create reorder requests for anything below.',
  },
  {
    icon: '📣',
    title: 'Delivery updates',
    desc: 'A carrier reports a delay. Update the shipment and notify customer service and the customer.',
  },
];

const VALUES: Concept[] = [
  {
    icon: '📏',
    title: 'Consistent decisions',
    desc: 'Every order, shipment, and issue is handled by the same rules your best people use, not by whoever happens to pick it up.',
  },
  {
    icon: '⚡',
    title: 'Faster response',
    desc: 'Work starts the moment data arrives or an event happens, instead of waiting for someone to notice it.',
  },
  {
    icon: '🎯',
    title: 'Less manual work',
    desc: 'Routine hand-offs between systems run on their own, so people spend their time on the decisions that need them.',
  },
  {
    icon: '🤝',
    title: 'People stay in control',
    desc: 'Routine cases run end to end. Exceptions go to a person with the facts and a recommendation.',
  },
];

const EXAMPLES: Example[] = [
  {
    icon: '🚚',
    title: 'Late sales order',
    sop: '"If an order for a key customer will ship late, check whether another plant can fill it. Compare cost and delivery date, and ask the planner to approve."',
    result: 'SCO rates the issue, explains the cause (for example, a delayed part), lists options such as "move the order to another plant" or "wait and expedite shipping" with their cost and time impact, and marks one as recommended.',
  },
  {
    icon: '🏭',
    title: 'Supplier delay',
    sop: '"If a supplier confirms a delay, find the production orders that depend on it. Treat any order that puts a customer delivery at risk as high priority and source it from a backup supplier."',
    result: 'SCO links the delay to the orders it affects, raises the priority of issues that threaten customer dates, and starts the backup-supplier sourcing process for those orders.',
  },
  {
    icon: '📦',
    title: 'Low inventory',
    sop: '"If stock falls below safety level, reorder from the preferred supplier. If that supplier can\'t deliver in time, escalate to the buyer."',
    result: 'SCO handles the usual case the same way every time, and sends only the exceptions to a buyer to decide.',
  },
];

const LIFECYCLE: Step[] = [
  {
    title: 'SCO detects an issue',
    desc: 'A KPI finds a record that breaks a business rule, such as an order shipping late. Issues can also come from other systems.',
  },
  {
    title: 'Your SOP runs automatically',
    desc: 'The business process for that type of issue gathers the facts and applies your decision rules.',
  },
  {
    title: 'The issue is rated and explained',
    desc: 'SCO records how severe and how urgent the issue is, the root cause, and the business impact.',
  },
  {
    title: 'A decision is made',
    desc: 'Either the process decides on its own, or a person reviews the options and picks one.',
  },
  {
    title: 'The decision is carried out',
    desc: 'The process kicks off the actions in your other systems, such as creating a purchase order in the ERP, notifying a supplier, or rebooking a shipment with a carrier. When the actions succeed, the issue closes. If one fails, the issue is flagged for attention.',
  },
];

const DOC_LINKS: DocLink[] = [
  {
    title: 'Introduction to Interoperability Productions',
    sub: 'How services, business processes, and operations connect systems',
    url: `${DOCS}?KEY=EGIN_intro`,
  },
  {
    title: 'Business Processes and Business Logic',
    sub: 'The kinds of logic a business process can contain',
    url: `${DOCS}?KEY=EGIN_busproc`,
  },
  {
    title: 'Issue Management',
    sub: 'How SCO finds, analyzes, and tracks issues',
    url: `${DOCS}?KEY=SCINTRO_issuemgmt`,
  },
  {
    title: 'Using BPL for Issue Analysis (Tutorial)',
    sub: 'For developers: building an issue analysis business process',
    url: `${DOCS}?KEY=SCINTRO_bpl`,
  },
  {
    title: 'Adding and Selecting Workflow Scenarios',
    sub: 'For developers: offering resolution options to users',
    url: `${DOCS}?KEY=SCINTRO_workflowscen`,
  },
];

/**
 * Business Processes — documentation-only view of workflow automation, including issue analysis.
 * Authoring is not supported in the Workbench yet, so this page explains the business
 * value with examples and links to the SCO docs.
 */
@Component({
  selector: 'app-business-process',
  standalone: true,
  imports: [CommonModule, PageHeaderComponent],
  templateUrl: './business-process.html',
  styleUrl: './business-process.css',
})
export class BusinessProcessComponent {
  triggers = TRIGGERS;
  workflows = WORKFLOWS;
  values = VALUES;
  examples = EXAMPLES;
  lifecycle = LIFECYCLE;
  docLinks = DOC_LINKS;
}
