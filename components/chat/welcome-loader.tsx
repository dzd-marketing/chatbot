/**
 * Animated orb shown above the welcome message. Plain-CSS port of the
 * styled-components loader; styles live in app/globals.css (.dzd-loader).
 * The SVG only defines the morphing mask that cuts the gradient box.
 */
export const WelcomeLoader = () => (
  <div aria-hidden="true" className="dzd-loader">
    <svg height={100} viewBox="0 0 100 100" width={100}>
      <defs>
        <mask id="dzd-loader-clipping">
          <polygon fill="black" points="0,0 100,0 100,100 0,100" />
          <polygon fill="white" points="25,25 75,25 50,75" />
          <polygon fill="white" points="50,25 75,75 25,75" />
          <polygon fill="white" points="35,35 65,35 50,65" />
          <polygon fill="white" points="35,35 65,35 50,65" />
          <polygon fill="white" points="35,35 65,35 50,65" />
          <polygon fill="white" points="35,35 65,35 50,65" />
        </mask>
      </defs>
    </svg>
    <div className="dzd-loader-box" />
  </div>
);
