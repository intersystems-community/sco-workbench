import { Pipe, PipeTransform, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

/**
 * Render GitHub-flavored markdown to trusted HTML for the assistant timeline.
 *
 * The source is the agent's own streamed prose (not arbitrary user input), and
 * `marked` escapes raw HTML by default, so we bypass Angular's sanitizer to keep
 * the rendered tables/code/lists intact — matching the original chat UI which
 * injected marked() output straight into innerHTML.
 */
@Pipe({ name: 'markdown', standalone: true })
export class MarkdownPipe implements PipeTransform {
  private readonly sanitizer = inject(DomSanitizer);

  transform(value: string | null | undefined): SafeHtml {
    const html = marked.parse(value ?? '', { async: false }) as string;
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }
}
