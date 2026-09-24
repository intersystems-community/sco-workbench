import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PageHeaderComponent } from '../shared/page-header';

@Component({
  selector: 'app-others',
  standalone: true,
  imports: [CommonModule, PageHeaderComponent],
  templateUrl: './others.html',
  styleUrl: './others.css',
})
export class OthersComponent {}
