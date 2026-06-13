export default function Page() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <div className="flex flex-col items-center gap-4 text-center">
        <svg
          aria-hidden="true"
          className="size-20"
          fill="none"
          viewBox="0 0 20 20"
          xmlns="http://www.w3.org/2000/svg"
          stroke="currentColor"
          strokeWidth="0.5"
        >
          <path
            d="M14.2 14.2H17V6.9375C17 4.76288 15.2371 3 13.0625 3H5.8V5.8M14.2 14.2V7.79063L7.79062 14.2H14.2ZM14.2 14.2V17H6.9375C4.76288 17 3 15.2371 3 13.0625V5.8H5.8M5.8 5.8V12.2313L12.2313 5.8H5.8Z"
            strokeLinejoin="round"
          />
        </svg>
        <p className="text-sm font-medium text-muted-foreground">
          Start building with v0 by writing a prompt.
        </p>
      </div>
    </main>
  )
}
