import { motion } from "framer-motion";
import { WelcomeLoader } from "./welcome-loader";

export const Greeting = () => (
  <div className="flex flex-col items-center px-4" key="overview">
    <motion.div
      animate={{ opacity: 1, scale: 1 }}
      className="mb-8"
      initial={{ opacity: 0, scale: 0.9 }}
      transition={{ delay: 0.2, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
    >
      <WelcomeLoader />
    </motion.div>
    <motion.h1
      animate={{ opacity: 1, y: 0 }}
      className="text-center font-semibold text-2xl tracking-tight text-foreground md:text-3xl"
      initial={{ opacity: 0, y: 10 }}
      transition={{ delay: 0.35, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
    >
      Hi, I&apos;m <span className="text-brand-ink">DZD AI</span>. What are we
      studying today?
    </motion.h1>
    <motion.p
      animate={{ opacity: 1, y: 0 }}
      className="mt-3 max-w-md text-balance text-center text-muted-foreground text-sm"
      initial={{ opacity: 0, y: 10 }}
      transition={{ delay: 0.5, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
    >
      Step-by-step help for A/L, O/L, Grade 5 Scholarship and university
      subjects, in English, සිංහල or தமிழ்.
    </motion.p>
  </div>
);
