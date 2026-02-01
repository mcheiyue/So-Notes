import { useEffect } from "react";
import { Canvas } from "./components/Canvas";

function App() {
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    
    const handleChange = (e: MediaQueryListEvent | MediaQueryList) => {
      if (e.matches) {
        document.documentElement.classList.add('dark');
        document.documentElement.classList.add('os-dark'); // Also adding custom class just in case
      } else {
        document.documentElement.classList.remove('dark');
        document.documentElement.classList.remove('os-dark');
      }
    };

    // Initial check
    handleChange(mediaQuery);

    // Listener
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return (
    <div className="w-screen h-screen">
       <Canvas />
    </div>
  );
}

export default App;
