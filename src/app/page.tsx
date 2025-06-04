import ScreenCatcherClient from '@/components/screen-catcher-client';

export default function HomePage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-4 bg-background font-body">
      <ScreenCatcherClient />
    </main>
  );
}
