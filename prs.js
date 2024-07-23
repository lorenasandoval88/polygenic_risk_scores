function Match2(data){
    let data2 = {}
  // extract harmonized data from PGS entry first
  const indChr = data.pgs.cols.indexOf('hm_chr')
  const indPos = data.pgs.cols.indexOf('hm_pos')
  const indOther_allele = data.pgs.cols.indexOf('other_allele')
  const indEffect_allele = data.pgs.cols.indexOf('effect_allele')
  const indGenotype = data.my23.cols.indexOf('genotype')
    // match
    let dtMatch = []
    const n = data.pgs.dt.length
        for (let i=0; i<n; i++){
            let matchFloor = 0
              let r = data.pgs.dt[i]
            //also filter 23 and me variants if they don't match pgs alt or effect allele 
            let regexPattern = new RegExp([r[indEffect_allele], r[indOther_allele]].join('|'))
  
            if (dtMatch.length > 0) {
                matchFloor = dtMatch.at(-1)[0][4]
            }
           // console.log("dtmacch i",r, data.my23.dt.filter(myr => (myr[2] == r[indPos])))
            let dtMatch_i = data.my23.dt.filter(myr => (myr[2] == r[indPos]))
               .filter(myr => (myr[1] == r[indChr]))
            // remove 23 variants that don't match pgs effect or other allele    
               .filter(myr => regexPattern.test(myr[indGenotype])) 
    
            if (dtMatch_i.length > 0) {
                dtMatch.push(dtMatch_i.concat([r]))
            }
        } 
            data2.pgsMatchMy23 = dtMatch
            let calcRiskScore = []
            let alleles = []
            // calculate Risk
            let logR = 0
            // log(0)=1
            let ind_effect_weight = data.pgs.cols.indexOf('effect_weight')
            dtMatch.forEach((m, i) => {
                calcRiskScore[i] = 0
                // default no risk
                alleles[i] = 0
                // default no alele
                let mi = m[0][3].match(/^[ACGT]{2}$/)
                // we'll only consider duplets in the 23adme report
                if (mi) {
                    //'effect_allele', 'other_allele', 'effect_weight'
                    mi = mi[0]
                    // 23andme match
                    let pi = m.at(-1)
                    //pgs match
                    let alele = pi[indEffect_allele]
                    let L = mi.match(RegExp(alele, 'g'))
                    // how many, 0,1, or 2
                    if (L) {
                        L = L.length
                        calcRiskScore[i] = L * pi[ind_effect_weight]
                        alleles[i] = L
                    }
                }
            })
            data2.pgs_id = data.pgs.meta.pgs_id
            data2.alleles = alleles
            data2.calcRiskScore = calcRiskScore
            let weight_idx = data.pgs.cols.indexOf('effect_weight')
            let weights = data.pgs.dt.map(row => row[weight_idx])
            // warning: no matches found!
            if (calcRiskScore.length == 0) { 
                data2.PRS = "there are no matches :-("
                data2.QC = false
                data2.QCtext = 'there are no matches :-('
                //console.log('there are no matches :-(',data.PRS)
            }else if (calcRiskScore.reduce((a, b) => Math.max(a, b)) > 100) { //&&(calcRiskScore.reduce((a,b)=>Math.max(a,b))<=1)){ // hazard ratios?
                data2.PRS = Math.exp(calcRiskScore.reduce((a, b) => a + b))
            data2.QC = false
                data2.QCtext = 'these are large betas :-('
                //console.log('these are large betas :-(',weights)
            } else if (weights.reduce((a, b) => Math.min(a, b)) > -0.00002 ) {
                data2.PRS = Math.exp(calcRiskScore.reduce((a, b) => a + b))
                data2.QC = false
                data2.QCtext = 'these are not betas :-('
                //console.log('these are not betas :-(',weights) 
            }  else{
                data2.PRS = Math.exp(calcRiskScore.reduce((a, b) => a + b))
                data2.QC = true
                data2.QCtext = ''
            }
  
  return data2
  }
  
  export{
    Match2
  }