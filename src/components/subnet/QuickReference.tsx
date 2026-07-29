export interface QuickReferenceProps {
  isOpen: boolean;
  onToggle: () => void;
}

export function QuickReference({ isOpen, onToggle }: QuickReferenceProps) {
  if (!isOpen) {
    return (
      <button onClick={onToggle} className="reference-toggle" aria-label="Show quick reference">
        ☰ Reference
      </button>
    );
  }

  return (
    <div className="quick-reference">
      <div className="reference-header">
        <h3>Quick Reference</h3>
        <button onClick={onToggle} className="reference-close" aria-label="Hide quick reference">
          ×
        </button>
      </div>

      <div className="reference-content">
        <section>
          <h4>RFC1918 Private Ranges</h4>
          <table className="reference-table">
            <tbody>
              <tr>
                <td className="monospace">10.0.0.0/8</td>
                <td>16,777,216 hosts</td>
              </tr>
              <tr>
                <td className="monospace">172.16.0.0/12</td>
                <td>1,048,576 hosts</td>
              </tr>
              <tr>
                <td className="monospace">192.168.0.0/16</td>
                <td>65,536 hosts</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section>
          <h4>Common Subnet Masks</h4>
          <table className="reference-table">
            <tbody>
              <tr>
                <td className="monospace">/24</td>
                <td className="monospace">255.255.255.0</td>
                <td>254 hosts</td>
              </tr>
              <tr>
                <td className="monospace">/25</td>
                <td className="monospace">255.255.255.128</td>
                <td>126 hosts</td>
              </tr>
              <tr>
                <td className="monospace">/26</td>
                <td className="monospace">255.255.255.192</td>
                <td>62 hosts</td>
              </tr>
              <tr>
                <td className="monospace">/27</td>
                <td className="monospace">255.255.255.224</td>
                <td>30 hosts</td>
              </tr>
              <tr>
                <td className="monospace">/28</td>
                <td className="monospace">255.255.255.240</td>
                <td>14 hosts</td>
              </tr>
              <tr>
                <td className="monospace">/29</td>
                <td className="monospace">255.255.255.248</td>
                <td>6 hosts</td>
              </tr>
              <tr>
                <td className="monospace">/30</td>
                <td className="monospace">255.255.255.252</td>
                <td>2 hosts</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
