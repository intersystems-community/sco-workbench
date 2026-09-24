import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PageHeaderComponent } from '../shared/page-header';

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

const CONCEPTS: Concept[] = [
  {
    icon: '🔀',
    title: 'Business Process (BPL)',
    desc: 'A graphical, long-running workflow defined in Business Process Language that orchestrates activities, calls, and decisions across your supply chain.',
  },
  {
    icon: '🧩',
    title: 'Activities & calls',
    desc: 'Steps such as data transforms, synchronous/asynchronous calls to business operations, code blocks, and branching logic (if / switch / loops).',
  },
  {
    icon: '📨',
    title: 'Request / response messages',
    desc: 'Typed messages flow between hosts. A process receives a request, coordinates the work, and returns a response — with full message tracing.',
  },
  {
    icon: '🛠️',
    title: 'Where you build it',
    desc: 'Business processes are authored in the  Interoperability designer (Management Portal) and deployed onto a running production.',
  },
];

const DOC_LINKS: DocLink[] = [
  {
    title: 'Developing Business Processes (BPL)',
    sub: 'The BPL editor, activities, context, and error handling',
    url: 'https://docs.intersystems.com/supplychain20261/csp/docbook/DocBook.UI.Page.cls?KEY=EGDV',
  },
  {
    title: 'Productions & Business Hosts',
    sub: 'How services, processes, and operations wire together in a production',
    url: 'https://docs.intersystems.com/supplychain20261/csp/docbook/DocBook.UI.Page.cls?KEY=EGIN',
  },
  {
    title: 'InterSystems Supply Chain Orchestrator',
    sub: 'Product documentation home',
    url: 'https://docs.intersystems.com/supplychain20261/csp/docbook/DocBook.UI.Page.cls',
  },
];

/**
 * Business Process — documentation-only view.
 *
 * The Workbench does not (yet) manage BPL business processes through its own UI,
 * so this page explains the feature and links to the official docs rather than
 * exposing an editor. Note: the embedded AI assistant CAN generate and deploy a
 * BPL process as part of a data pipeline — the hint below points users there.
 */
@Component({
  selector: 'app-business-process',
  standalone: true,
  imports: [CommonModule, PageHeaderComponent],
  templateUrl: './business-process.html',
  styleUrl: './business-process.css',
})
export class BusinessProcessComponent {
  concepts = CONCEPTS;
  docLinks = DOC_LINKS;
}
