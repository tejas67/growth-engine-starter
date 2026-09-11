<script lang="ts">
  let { name, size = 18 }: { name: string; size?: number } = $props();
  const paths: Record<string, string> = {
    settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
    inbox: 'M4 4h16v16H4z M4 13h5l2 3h2l2-3h5',
    reply: 'M21 11a8 8 0 0 1-8 8H6l-4 3V11a9 9 0 0 1 19 0Z M7 10h10 M7 14h6',
    chart: 'M4 3v17h17 M9 15v-4 M14 15V7 M19 15V4',
    search: 'm21 21-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    arrow: 'M5 12h14 m-5-5 5 5-5 5',
    back: 'M19 12H5 m5-5-5 5 5 5',
    check: 'm5 12 4 4L19 6',
    edit: 'm16 3 5 5-12 12H4v-5L16 3Z M13 6l5 5',
    external: 'M14 3h7v7 M21 3 11 13 M10 3H3v18h18v-7',
    refresh: 'M20 7a9 9 0 1 0 1 8 M20 3v5h-5',
    chevron: 'm9 5 7 7-7 7',
    pause: 'M8 5v14 M16 5v14',
    mail: 'M3 5h18v14H3z m0 1 9 7 9-7',
    logout: 'M9 3H3v18h6 M8 12h13 m-5-5 5 5-5 5',
  };
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.6"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"><path d={paths[name] ?? paths.inbox} /></svg
>
